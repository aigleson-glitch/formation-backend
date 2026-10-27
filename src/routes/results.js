import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { wrap } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { buildResults } from '../lib/results.js';

// « Mes résultats » : statut Compétent / Pas encore compétent par module, notes et état de chaque quiz et devoir.
// La connexion est exigée route par route (et non sur tout « / ») pour ne pas bloquer les routes publiques montées après.
const router = Router();

router.get('/my/results', requireAuth, wrap(async (req, res) => {
  const enrollments = await prisma.enrollment.findMany({
    where: { userId: req.user.id, status: { in: ['active', 'completed'] } },
    include: { course: { select: { id: true, title: true, slug: true } } },
    orderBy: { enrolledAt: 'desc' },
  });
  if (enrollments.length === 0) return res.json({ courses: [] });

  const enrollmentIds = enrollments.map((e) => e.id);
  const modules = await prisma.module.findMany({
    where: { courseId: { in: enrollments.map((e) => e.courseId) } },
    select: { id: true, courseId: true, title: true, position: true },
  });
  const moduleIds = modules.map((m) => m.id);

  const [assessments, lessonRows, lessonProgress, attempts, submissions, moduleResults] = await Promise.all([
    prisma.assessment.findMany({
      where: { moduleId: { in: moduleIds } },
      select: { id: true, moduleId: true, type: true, title: true, isRequired: true, passMark: true, maxAttempts: true, position: true },
    }),
    prisma.lesson.findMany({ where: { chapter: { moduleId: { in: moduleIds } } }, select: { id: true, chapter: { select: { moduleId: true } } } }),
    prisma.lessonProgress.findMany({ where: { enrollmentId: { in: enrollmentIds } }, select: { enrollmentId: true, lessonId: true } }),
    prisma.attempt.findMany({ where: { enrollmentId: { in: enrollmentIds } }, select: { enrollmentId: true, assessmentId: true, status: true, scorePct: true, passed: true } }),
    prisma.submission.findMany({ where: { enrollmentId: { in: enrollmentIds } }, select: { enrollmentId: true, assessmentId: true, attemptNo: true, status: true, scorePct: true, passed: true } }),
    prisma.moduleResult.findMany({ where: { enrollmentId: { in: enrollmentIds } }, select: { enrollmentId: true, moduleId: true, status: true, scorePct: true } }),
  ]);

  res.json({
    courses: buildResults({
      enrollments, modules, assessments,
      lessons: lessonRows.map((l) => ({ id: l.id, moduleId: l.chapter.moduleId })),
      lessonProgress, attempts, submissions, moduleResults,
    }),
  });
}));

export default router;
