import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { wrap, HttpError } from '../lib/http.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireRole('instructor', 'admin'));

const slugify = (s) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// Règle 15 : seuls les formateurs habilités peuvent enseigner à des mineurs
function assertCanTeach(instructor, audiences) {
  const minors = audiences.some((a) => a === 'child' || a === 'teen');
  if (minors && !instructor.canTeachMinors) {
    throw new HttpError(403, 'Vous n\'êtes pas habilité à enseigner à des mineurs');
  }
}

export async function assertOwnsCourse(user, courseId) {
  const course = await prisma.course.findUnique({ where: { id: courseId }, include: { audiences: true } });
  if (!course) throw new HttpError(404, 'Formation introuvable');
  if (user.role === 'admin') return course;
  const link = await prisma.courseInstructor.findUnique({ where: { courseId_userId: { courseId, userId: user.id } } });
  if (!link) throw new HttpError(403, 'Cette formation ne vous est pas affectée');
  return course;
}

router.get('/courses', wrap(async (req, res) => {
  res.json(await prisma.course.findMany({
    where: req.user.role === 'admin' ? {} : { instructors: { some: { userId: req.user.id } } },
    include: { audiences: true, _count: { select: { modules: true, enrollments: true } } },
    orderBy: { updatedAt: 'desc' },
  }));
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
  assertCanTeach(req.user, audiences);
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
    assertCanTeach(req.user, audiences);
    await prisma.courseAudience.deleteMany({ where: { courseId: course.id } });
    await prisma.courseAudience.createMany({ data: audiences.map((ageGroup) => ({ courseId: course.id, ageGroup })) });
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
    // Règle 15 revérifiée à la publication : tous les formateurs affectés doivent être habilités
    if (course.audiences.some((a) => a.ageGroup !== 'adult')) {
      const bad = await prisma.courseInstructor.count({ where: { courseId: course.id, user: { canTeachMinors: false } } });
      if (bad > 0) throw new HttpError(422, 'Un formateur affecté n\'est pas habilité à enseigner à des mineurs');
    }
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

// ── Modules, chapitres, leçons ───────────────────────────────
const nextPosition = async (model, where) => ((await prisma[model].aggregate({ where, _max: { position: true } }))._max.position ?? 0) + 1;

router.post('/courses/:id/modules', validate(z.object({ title: z.string().min(1), description: z.string().optional(), imageUrl: z.string().url().optional() })), wrap(async (req, res) => {
  const course = await assertOwnsCourse(req.user, req.params.id);
  const position = await nextPosition('module', { courseId: course.id });
  res.status(201).json(await prisma.module.create({ data: { ...req.body, courseId: course.id, position } }));
}));

router.post('/modules/:id/chapters', validate(z.object({ title: z.string().min(1) })), wrap(async (req, res) => {
  const mod = await prisma.module.findUnique({ where: { id: req.params.id } });
  if (!mod) throw new HttpError(404, 'Module introuvable');
  await assertOwnsCourse(req.user, mod.courseId);
  const position = await nextPosition('chapter', { moduleId: mod.id });
  res.status(201).json(await prisma.chapter.create({ data: { title: req.body.title, moduleId: mod.id, position } }));
}));

const lessonSchema = z.object({
  title: z.string().min(1),
  type: z.enum(['text', 'video', 'audio', 'pdf']).default('text'),
  content: z.string().optional(),
  mediaUrl: z.string().url().optional(),
  durationSec: z.number().int().positive().optional(),
});

router.post('/chapters/:id/lessons', validate(lessonSchema), wrap(async (req, res) => {
  const chapter = await prisma.chapter.findUnique({ where: { id: req.params.id }, include: { module: true } });
  if (!chapter) throw new HttpError(404, 'Chapitre introuvable');
  await assertOwnsCourse(req.user, chapter.module.courseId);
  if (req.body.type !== 'text' && !req.body.mediaUrl) throw new HttpError(422, 'Un média est requis pour ce type de leçon');
  const position = await nextPosition('lesson', { chapterId: chapter.id });
  res.status(201).json(await prisma.lesson.create({ data: { ...req.body, chapterId: chapter.id, position } }));
}));

router.patch('/lessons/:id', validate(lessonSchema.partial()), wrap(async (req, res) => {
  const lesson = await prisma.lesson.findUnique({ where: { id: req.params.id }, include: { chapter: { include: { module: true } } } });
  if (!lesson) throw new HttpError(404, 'Leçon introuvable');
  await assertOwnsCourse(req.user, lesson.chapter.module.courseId);
  res.json(await prisma.lesson.update({ where: { id: lesson.id }, data: req.body }));
}));

export default router;
