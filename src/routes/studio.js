import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { wrap, HttpError } from '../lib/http.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { hasMinors, minorsRuleProblem, reorderProblem, mediaProblem, isPlayable } from '../lib/studioRules.js';
import { assertOwnsCourse } from '../lib/studioAccess.js';

import { UUID_RE } from '../lib/chapterProfile.js';

const checkId = (id, what = 'Élément') => {
  if (!UUID_RE.test(String(id))) throw new HttpError(404, `${what} introuvable`);
};

const router = Router();
router.use(requireAuth, requireRole('instructor', 'admin'));
const adminOnly = requireRole('admin');

const slugify = (s) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// Formateurs d'une formation, avec ce qu'il faut pour la règle 15
async function instructorsOf(courseId) {
  const links = await prisma.courseInstructor.findMany({
    where: { courseId },
    select: { user: { select: { id: true, firstName: true, lastName: true, canTeachMinors: true, isActive: true } } },
  });
  return links.map((l) => l.user);
}

// Supprimer ou réordonner du contenu d'une formation suivie détruirait ou bouleverserait des résultats d'élèves.
async function assertNoEnrollments(courseId, action) {
  const n = await prisma.enrollment.count({ where: { courseId } });
  if (n > 0) throw new HttpError(409, `Des apprenants sont inscrits : ${action} est impossible. Corrigez le texte à la place, ou dépubliez la formation.`);
}

router.get('/courses', wrap(async (req, res) => {
  res.json(await prisma.course.findMany({
    where: req.user.role === 'admin' ? {} : { instructors: { some: { userId: req.user.id } } },
    include: { audiences: true, _count: { select: { modules: true, enrollments: true } } },
    orderBy: { updatedAt: 'desc' },
  }));
}));

// Arbre complet de la formation, brouillon compris : tout ce qu'il faut pour afficher l'éditeur
router.get('/courses/:id', wrap(async (req, res) => {
  await assertOwnsCourse(req.user, req.params.id);
  const c = await prisma.course.findUnique({
    where: { id: req.params.id },
    include: {
      audiences: true,
      instructors: { select: { user: { select: { id: true, firstName: true, lastName: true, canTeachMinors: true, isActive: true } } } },
      modules: {
        orderBy: { position: 'asc' },
        include: {
          chapters: {
            orderBy: { position: 'asc' },
            include: {
              aiProfile: { select: { version: true } },
              lessons: { orderBy: { position: 'asc' }, select: { id: true, title: true, type: true, durationSec: true, position: true } },
            },
          },
          assessments: { orderBy: { position: 'asc' }, include: { _count: { select: { questions: true, attempts: true } } } },
        },
      },
      _count: { select: { enrollments: true } },
    },
  });
  const { instructors, modules, _count, ...course } = c;
  res.json({
    ...course,
    enrollmentCount: _count.enrollments,
    instructors: instructors.map((i) => i.user),
    modules: modules.map(({ chapters, assessments, ...m }) => ({
      ...m,
      chapters: chapters.map(({ aiProfile, ...ch }) => ({ ...ch, hasAiProfile: !!aiProfile })),
      assessments: assessments.map(({ _count: ac, ...a }) => ({
        ...a, questionCount: ac.questions, attemptsCount: ac.attempts, locked: ac.attempts > 0,
        playable: isPlayable(a.type, ac.questions), // un quiz sans question ne compte pas (voir progress.js)
      })),
    })),
  });
}));

const courseSchema = z.object({
  categoryId: z.string().uuid(),
  title: z.string().min(3),
  description: z.string().optional(),
  level: z.enum(['beginner', 'intermediate', 'advanced']).default('beginner'),
  language: z.string().default('fr'),
  price: z.number().min(0).default(0),
  currency: z.string().default('XAF'),
  defaultPassMark: z.number().int().min(0).max(100).default(70),
  sequentialUnlock: z.boolean().default(false),
  coverUrl: z.string().url().optional(),
  audiences: z.array(z.enum(['child', 'teen', 'adult'])).min(1),
});

router.post('/courses', validate(courseSchema), wrap(async (req, res) => {
  const { audiences, ...data } = req.body;
  // Un formateur qui crée une formation en devient le formateur : il doit pouvoir enseigner aux mineurs.
  // Un administrateur crée un brouillon sans formateur ; la règle est vérifiée à l'affectation et à la publication.
  if (req.user.role === 'instructor' && hasMinors(audiences) && !req.user.canTeachMinors) {
    throw new HttpError(403, 'Vous n\'êtes pas habilité à enseigner à des mineurs');
  }
  let slug = slugify(data.title), n = 1;
  while (await prisma.course.findUnique({ where: { slug } })) slug = `${slugify(data.title)}-${++n}`;

  const course = await prisma.course.create({
    data: {
      ...data, slug,
      audiences: { create: audiences.map((ageGroup) => ({ ageGroup })) },
      ...(req.user.role === 'instructor' && { instructors: { create: { userId: req.user.id } } }),
    },
    include: { audiences: true },
  });
  res.status(201).json(course);
}));

router.patch('/courses/:id', validate(courseSchema.partial()), wrap(async (req, res) => {
  const course = await assertOwnsCourse(req.user, req.params.id);
  const { audiences, ...data } = req.body;
  if (audiences) {
    // La règle porte sur les formateurs AFFECTÉS à la formation, pas sur la personne qui modifie
    const problem = minorsRuleProblem({ audiences, instructors: await instructorsOf(course.id), published: course.isPublished });
    if (problem) throw new HttpError(403, problem);
    await prisma.$transaction([
      prisma.courseAudience.deleteMany({ where: { courseId: course.id } }),
      prisma.courseAudience.createMany({ data: audiences.map((ageGroup) => ({ courseId: course.id, ageGroup })) }),
    ]);
  }
  res.json(await prisma.course.update({ where: { id: course.id }, data, include: { audiences: true } }));
}));

// Publication / dépublication (règle 9 : pas de suppression d'un cours avec inscrits)
router.post('/courses/:id/publish', validate(z.object({ published: z.boolean() })), wrap(async (req, res) => {
  const course = await assertOwnsCourse(req.user, req.params.id);
  if (req.body.published) {
    if (course.audiences.length === 0) throw new HttpError(422, 'Choisissez au moins un public cible');
    const lessons = await prisma.lesson.count({ where: { chapter: { module: { courseId: course.id } } } });
    if (lessons === 0) throw new HttpError(422, 'Ajoutez au moins une leçon avant de publier');
    // Un quiz vide bloquerait le module pour toujours : il faut au moins une question
    const emptyQuizzes = await prisma.assessment.count({ where: { module: { courseId: course.id }, type: { in: ['quiz', 'mcq'] }, questions: { none: {} } } });
    if (emptyQuizzes > 0) throw new HttpError(422, 'Un quiz ne contient aucune question : ajoutez-en ou supprimez-le avant de publier');
    // Règle 15 revérifiée à la publication : formateurs habilités, et au moins un pour une formation destinée aux mineurs
    const problem = minorsRuleProblem({
      audiences: course.audiences.map((a) => a.ageGroup), instructors: await instructorsOf(course.id), published: true,
    });
    if (problem) throw new HttpError(422, problem);
  }
  res.json(await prisma.course.update({ where: { id: course.id }, data: { isPublished: req.body.published } }));
}));

router.delete('/courses/:id', wrap(async (req, res) => {
  const course = await assertOwnsCourse(req.user, req.params.id);
  const enrolled = await prisma.enrollment.count({ where: { courseId: course.id } });
  if (enrolled > 0) throw new HttpError(409, 'Des apprenants sont inscrits : dépubliez la formation au lieu de la supprimer');
  await prisma.course.delete({ where: { id: course.id } });
  res.status(204).end();
}));

// ── Affectation des formateurs (administrateur) ──────────────
const instructorView = (u) => ({ id: u.id, firstName: u.firstName, lastName: u.lastName, canTeachMinors: u.canTeachMinors });

router.post('/courses/:id/instructors', adminOnly, validate(z.object({ userId: z.string().uuid() })), wrap(async (req, res) => {
  const course = await assertOwnsCourse(req.user, req.params.id);
  const user = await prisma.user.findFirst({ where: { id: req.body.userId, role: 'instructor', isActive: true } });
  if (!user) throw new HttpError(404, 'Formateur introuvable (il faut un compte actif de rôle formateur)');
  if (hasMinors(course.audiences.map((a) => a.ageGroup)) && !user.canTeachMinors) {
    throw new HttpError(403, 'Ce formateur n\'est pas habilité à enseigner à des mineurs');
  }
  await prisma.courseInstructor.createMany({ data: [{ courseId: course.id, userId: user.id }], skipDuplicates: true });
  res.status(201).json({ instructors: (await instructorsOf(course.id)).map(instructorView) });
}));

router.delete('/courses/:id/instructors/:userId', adminOnly, wrap(async (req, res) => {
  const course = await assertOwnsCourse(req.user, req.params.id);
  checkId(req.params.userId, 'Formateur');
  const all = await instructorsOf(course.id);
  if (!all.some((u) => u.id === req.params.userId)) throw new HttpError(404, 'Ce formateur n\'est pas affecté à cette formation');
  // Une formation publiée pour mineurs ne peut pas rester sans formateur habilité
  const remaining = all.filter((u) => u.id !== req.params.userId && u.canTeachMinors && u.isActive);
  const problem = minorsRuleProblem({ audiences: course.audiences.map((a) => a.ageGroup), instructors: remaining, published: course.isPublished });
  if (problem) throw new HttpError(409, `Retrait impossible : ${problem}`);
  await prisma.courseInstructor.delete({ where: { courseId_userId: { courseId: course.id, userId: req.params.userId } } });
  res.status(204).end();
}));

// ── Modules, chapitres, leçons ───────────────────────────────
const nextPosition = async (model, where) => ((await prisma[model].aggregate({ where, _max: { position: true } }))._max.position ?? 0) + 1;

const reorderSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });

async function applyReorder(model, ids, currentIds) {
  const problem = reorderProblem(ids, currentIds);
  if (problem) throw new HttpError(422, problem);
  await prisma.$transaction(ids.map((id, i) => prisma[model].update({ where: { id }, data: { position: i + 1 } })));
}

async function loadModule(id) {
  checkId(id, 'Module');
  const mod = await prisma.module.findUnique({ where: { id } });
  if (!mod) throw new HttpError(404, 'Module introuvable');
  return mod;
}
async function loadChapter(id) {
  checkId(id, 'Chapitre');
  const chapter = await prisma.chapter.findUnique({ where: { id }, include: { module: true } });
  if (!chapter) throw new HttpError(404, 'Chapitre introuvable');
  return chapter;
}
async function loadLesson(id) {
  checkId(id, 'Leçon');
  const lesson = await prisma.lesson.findUnique({ where: { id }, include: { chapter: { include: { module: true } } } });
  if (!lesson) throw new HttpError(404, 'Leçon introuvable');
  return lesson;
}

router.post('/courses/:id/modules', validate(z.object({ title: z.string().min(1), description: z.string().optional(), imageUrl: z.string().url().optional() })), wrap(async (req, res) => {
  const course = await assertOwnsCourse(req.user, req.params.id);
  const position = await nextPosition('module', { courseId: course.id });
  res.status(201).json(await prisma.module.create({ data: { ...req.body, courseId: course.id, position } }));
}));

// L'ordre des modules détermine le déblocage séquentiel : il ne change plus une fois la formation suivie
router.post('/courses/:id/modules/reorder', validate(reorderSchema), wrap(async (req, res) => {
  const course = await assertOwnsCourse(req.user, req.params.id);
  await assertNoEnrollments(course.id, 'le changement d\'ordre des modules');
  const current = await prisma.module.findMany({ where: { courseId: course.id }, select: { id: true } });
  await applyReorder('module', req.body.ids, current.map((m) => m.id));
  res.json({ ok: true, ids: req.body.ids });
}));

router.patch('/modules/:id', validate(z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  imageUrl: z.string().url().nullable().optional(),
})), wrap(async (req, res) => {
  const mod = await loadModule(req.params.id);
  await assertOwnsCourse(req.user, mod.courseId);
  res.json(await prisma.module.update({ where: { id: mod.id }, data: req.body }));
}));

router.delete('/modules/:id', wrap(async (req, res) => {
  const mod = await loadModule(req.params.id);
  await assertOwnsCourse(req.user, mod.courseId);
  await assertNoEnrollments(mod.courseId, 'la suppression d\'un module');
  await prisma.module.delete({ where: { id: mod.id } });
  res.status(204).end();
}));

router.post('/modules/:id/chapters', validate(z.object({ title: z.string().min(1) })), wrap(async (req, res) => {
  const mod = await loadModule(req.params.id);
  await assertOwnsCourse(req.user, mod.courseId);
  const position = await nextPosition('chapter', { moduleId: mod.id });
  res.status(201).json(await prisma.chapter.create({ data: { title: req.body.title, moduleId: mod.id, position } }));
}));

router.post('/modules/:id/chapters/reorder', validate(reorderSchema), wrap(async (req, res) => {
  const mod = await loadModule(req.params.id);
  await assertOwnsCourse(req.user, mod.courseId);
  const current = await prisma.chapter.findMany({ where: { moduleId: mod.id }, select: { id: true } });
  await applyReorder('chapter', req.body.ids, current.map((c) => c.id));
  res.json({ ok: true, ids: req.body.ids });
}));

router.patch('/chapters/:id', validate(z.object({ title: z.string().min(1) })), wrap(async (req, res) => {
  const chapter = await loadChapter(req.params.id);
  await assertOwnsCourse(req.user, chapter.module.courseId);
  res.json(await prisma.chapter.update({ where: { id: chapter.id }, data: { title: req.body.title } }));
}));

router.delete('/chapters/:id', wrap(async (req, res) => {
  const chapter = await loadChapter(req.params.id);
  await assertOwnsCourse(req.user, chapter.module.courseId);
  await assertNoEnrollments(chapter.module.courseId, 'la suppression d\'un chapitre');
  await prisma.chapter.delete({ where: { id: chapter.id } });
  res.status(204).end();
}));

const lessonSchema = z.object({
  title: z.string().min(1),
  type: z.enum(['text', 'video', 'audio', 'pdf']).default('text'),
  content: z.string().optional(),
  mediaUrl: z.string().url().optional(),
  durationSec: z.number().int().positive().optional(),
});

router.post('/chapters/:id/lessons', validate(lessonSchema), wrap(async (req, res) => {
  const chapter = await loadChapter(req.params.id);
  await assertOwnsCourse(req.user, chapter.module.courseId);
  const problem = mediaProblem(req.body.type, req.body.mediaUrl);
  if (problem) throw new HttpError(422, problem);
  const position = await nextPosition('lesson', { chapterId: chapter.id });
  res.status(201).json(await prisma.lesson.create({ data: { ...req.body, chapterId: chapter.id, position } }));
}));

router.post('/chapters/:id/lessons/reorder', validate(reorderSchema), wrap(async (req, res) => {
  const chapter = await loadChapter(req.params.id);
  await assertOwnsCourse(req.user, chapter.module.courseId);
  const current = await prisma.lesson.findMany({ where: { chapterId: chapter.id }, select: { id: true } });
  await applyReorder('lesson', req.body.ids, current.map((l) => l.id));
  res.json({ ok: true, ids: req.body.ids });
}));

// Une leçon avec son contenu complet (l'arbre de la formation n'envoie que les titres)
router.get('/lessons/:id', wrap(async (req, res) => {
  const lesson = await loadLesson(req.params.id);
  await assertOwnsCourse(req.user, lesson.chapter.module.courseId);
  const { chapter, ...l } = lesson;
  res.json({ ...l, moduleId: chapter.moduleId, courseId: chapter.module.courseId });
}));

router.patch('/lessons/:id', validate(lessonSchema.partial()), wrap(async (req, res) => {
  const lesson = await loadLesson(req.params.id);
  await assertOwnsCourse(req.user, lesson.chapter.module.courseId);
  // Le type et le média doivent rester cohérents après la modification
  const problem = mediaProblem(req.body.type ?? lesson.type, req.body.mediaUrl ?? lesson.mediaUrl);
  if (problem) throw new HttpError(422, problem);
  res.json(await prisma.lesson.update({ where: { id: lesson.id }, data: req.body }));
}));

router.delete('/lessons/:id', wrap(async (req, res) => {
  const lesson = await loadLesson(req.params.id);
  await assertOwnsCourse(req.user, lesson.chapter.module.courseId);
  await assertNoEnrollments(lesson.chapter.module.courseId, 'la suppression d\'une leçon');
  await prisma.lesson.delete({ where: { id: lesson.id } });
  res.status(204).end();
}));

export default router;
