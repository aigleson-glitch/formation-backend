import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { wrap, HttpError } from '../lib/http.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, isActiveGuardian } from '../middleware/auth.js';
import { courseProgress, isModuleUnlocked } from '../lib/progress.js';

const router = Router();
router.use(requireAuth);

const enrollSchema = z.object({ forChildId: z.string().uuid().optional() });

/**
 * Inscription. Un apprenant s'inscrit lui-même ; un parent inscrit un enfant (règle 12).
 * Formation gratuite → active tout de suite. Payante → « pending » (le paiement arrive en phase 4,
 * l'inscription expire après 48 h sans paiement : règle 8, à traiter par une tâche planifiée).
 */
router.post('/courses/:courseId/enroll', validate(enrollSchema), wrap(async (req, res) => {
  const { forChildId } = req.body;
  let target = req.user;

  if (forChildId) {
    if (req.user.role !== 'parent' || !(await isActiveGuardian(req.user.id, forChildId))) {
      throw new HttpError(403, 'Vous ne pouvez inscrire que vos propres enfants');
    }
    target = await prisma.user.findUnique({ where: { id: forChildId } });
  } else if (req.user.role !== 'learner') {
    throw new HttpError(403, 'Seuls les apprenants peuvent s\'inscrire (un parent doit choisir un enfant)');
  }

  const course = await prisma.course.findFirst({
    where: { id: req.params.courseId, isPublished: true },
    include: { audiences: true },
  });
  if (!course) throw new HttpError(404, 'Formation introuvable');
  if (!course.audiences.some((a) => a.ageGroup === target.ageGroup)) {
    throw new HttpError(403, 'Cette formation ne s\'adresse pas au groupe d\'âge de cet apprenant');
  }

  const existing = await prisma.enrollment.findUnique({
    where: { userId_courseId: { userId: target.id, courseId: course.id } },
  });
  if (existing) return res.status(200).json({ enrollment: existing, alreadyEnrolled: true });

  const free = Number(course.price) === 0;
  const enrollment = await prisma.enrollment.create({
    data: { userId: target.id, courseId: course.id, status: free ? 'active' : 'pending' },
  });
  res.status(201).json({ enrollment, paymentRequired: !free });
}));

router.get('/my/enrollments', wrap(async (req, res) => {
  const list = await prisma.enrollment.findMany({
    where: { userId: req.user.id, status: { not: 'cancelled' } },
    include: {
      course: { select: { id: true, title: true, slug: true, coverUrl: true, category: { select: { name: true, color: true, icon: true } }, _count: { select: { modules: true } } } },
      certificate: { select: { code: true } },
    },
    orderBy: { enrolledAt: 'desc' },
  });
  const out = [];
  for (const e of list) out.push({ ...e, progressPct: e.status === 'pending' ? 0 : await courseProgress(e.id, e.courseId) });
  res.json(out);
}));

// Coches du menu latéral : identifiants des leçons terminées + progression globale
router.get('/my/enrollments/:id/progress', wrap(async (req, res) => {
  const e = await requireActiveEnrollment(req.user.id, { id: req.params.id });
  const rows = await prisma.lessonProgress.findMany({ where: { enrollmentId: e.id }, select: { lessonId: true } });
  res.json({ completedLessonIds: rows.map((r) => r.lessonId), progressPct: await courseProgress(e.id, e.courseId) });
}));

// Bouton « Continuer » : première leçon non terminée dans l'ordre du programme
router.get('/my/enrollments/:id/continue', wrap(async (req, res) => {
  const e = await requireActiveEnrollment(req.user.id, { id: req.params.id });
  const done = new Set((await prisma.lessonProgress.findMany({ where: { enrollmentId: e.id }, select: { lessonId: true } })).map((x) => x.lessonId));
  const modules = await prisma.module.findMany({
    where: { courseId: e.courseId }, orderBy: { position: 'asc' },
    include: { chapters: { orderBy: { position: 'asc' }, include: { lessons: { orderBy: { position: 'asc' }, select: { id: true } } } } },
  });
  for (const m of modules) {
    for (const c of m.chapters) {
      for (const l of c.lessons) if (!done.has(l.id)) return res.json({ lessonId: l.id });
    }
  }
  res.json({ lessonId: null, finished: true });
}));

// Règle 1 : contenu visible seulement si inscrit ET paiement confirmé (ou gratuit) → statut « active » ou « completed »
async function requireActiveEnrollment(userId, where) {
  const e = await prisma.enrollment.findFirst({ where: { ...where, userId } });
  if (!e) throw new HttpError(403, 'Vous n\'êtes pas inscrit à cette formation');
  if (e.status === 'pending') throw new HttpError(402, 'Paiement requis pour accéder au contenu');
  if (e.status === 'cancelled') throw new HttpError(403, 'Inscription annulée');
  return e;
}

async function loadLessonContext(lessonId) {
  const lesson = await prisma.lesson.findUnique({
    where: { id: lessonId },
    include: { chapter: { include: { module: { include: { course: true } } } } },
  });
  if (!lesson) throw new HttpError(404, 'Leçon introuvable');
  return lesson;
}

// Lecteur de leçon : contenu + précédent/suivant + état terminé + note perso
router.get('/lessons/:id', wrap(async (req, res) => {
  const lesson = await loadLessonContext(req.params.id);
  const { module, } = lesson.chapter;
  const course = module.course;
  const enrollment = await requireActiveEnrollment(req.user.id, { courseId: course.id });

  if (!(await isModuleUnlocked(enrollment.id, course, module))) {
    throw new HttpError(403, 'Terminez le module précédent pour débloquer celui-ci');
  }

  // Ordre linéaire de toutes les leçons du cours pour précédent / suivant
  const flat = await prisma.lesson.findMany({
    where: { chapter: { module: { courseId: course.id } } },
    select: { id: true, position: true, chapter: { select: { position: true, module: { select: { position: true } } } } },
  });
  flat.sort((a, b) =>
    a.chapter.module.position - b.chapter.module.position ||
    a.chapter.position - b.chapter.position || a.position - b.position);
  const idx = flat.findIndex((l) => l.id === lesson.id);

  const [progress, note] = await Promise.all([
    prisma.lessonProgress.findUnique({ where: { enrollmentId_lessonId: { enrollmentId: enrollment.id, lessonId: lesson.id } } }),
    prisma.note.findFirst({ where: { userId: req.user.id, lessonId: lesson.id } }),
  ]);

  const { chapter, ...l } = lesson;
  res.json({
    lesson: l,
    course: { id: course.id, title: course.title, slug: course.slug },
    enrollmentId: enrollment.id,
    completed: !!progress,
    prevLessonId: flat[idx - 1]?.id ?? null,
    nextLessonId: flat[idx + 1]?.id ?? null,
    note: note?.content ?? '',
  });
}));

router.post('/lessons/:id/complete', wrap(async (req, res) => {
  const lesson = await loadLessonContext(req.params.id);
  const course = lesson.chapter.module.course;
  const enrollment = await requireActiveEnrollment(req.user.id, { courseId: course.id });
  if (!(await isModuleUnlocked(enrollment.id, course, lesson.chapter.module))) {
    throw new HttpError(403, 'Module verrouillé');
  }
  await prisma.lessonProgress.upsert({
    where: { enrollmentId_lessonId: { enrollmentId: enrollment.id, lessonId: lesson.id } },
    create: { enrollmentId: enrollment.id, lessonId: lesson.id },
    update: {},
  });
  res.json({ ok: true, progressPct: await courseProgress(enrollment.id, course.id) });
}));

router.delete('/lessons/:id/complete', wrap(async (req, res) => {
  const lesson = await loadLessonContext(req.params.id);
  const enrollment = await requireActiveEnrollment(req.user.id, { courseId: lesson.chapter.module.courseId });
  await prisma.lessonProgress.deleteMany({ where: { enrollmentId: enrollment.id, lessonId: lesson.id } });
  res.json({ ok: true, progressPct: await courseProgress(enrollment.id, lesson.chapter.module.courseId) });
}));

// Notes personnelles : une note par leçon et par utilisateur (upsert manuel, pas de contrainte unique dans le schéma)
router.put('/lessons/:id/note', validate(z.object({ content: z.string().max(10000) })), wrap(async (req, res) => {
  const lesson = await loadLessonContext(req.params.id);
  await requireActiveEnrollment(req.user.id, { courseId: lesson.chapter.module.courseId });
  const existing = await prisma.note.findFirst({ where: { userId: req.user.id, lessonId: lesson.id } });
  const note = existing
    ? await prisma.note.update({ where: { id: existing.id }, data: { content: req.body.content } })
    : await prisma.note.create({ data: { userId: req.user.id, lessonId: lesson.id, content: req.body.content } });
  res.json(note);
}));

// « Mes notes » regroupées par formation
router.get('/my/notes', wrap(async (req, res) => {
  res.json(await prisma.note.findMany({
    where: { userId: req.user.id },
    include: { lesson: { select: { id: true, title: true, chapter: { select: { module: { select: { course: { select: { id: true, title: true } } } } } } } } },
    orderBy: { updatedAt: 'desc' },
  }));
}));

export default router;
