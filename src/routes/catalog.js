import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';
import { wrap, HttpError } from '../lib/http.js';
import { syncAgeGroup } from '../lib/auth.js';
import { courseProgress } from '../lib/progress.js';

const router = Router();

// Authentification optionnelle : le catalogue est public mais filtré selon le groupe (règle 10)
async function optionalAuth(req, _res, next) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    try {
      const p = jwt.verify(h.slice(7), process.env.JWT_SECRET);
      const u = await prisma.user.findUnique({ where: { id: p.sub } });
      if (u?.isActive) req.user = await syncAgeGroup(u);
    } catch { /* jeton invalide : on traite comme anonyme */ }
  }
  next();
}

// Groupes d'âge visibles par l'utilisateur courant (null = pas de filtre)
export function visibleAudiences(user) {
  if (!user) return null;
  if (user.role === 'parent') return ['child', 'teen']; // un parent voit les formations enfants et ados
  if (user.role === 'learner' && user.ageGroup) return [user.ageGroup];
  return null; // formateur, admin
}

const courseSummary = {
  id: true, title: true, slug: true, description: true, level: true, language: true,
  price: true, currency: true, coverUrl: true,
  category: { select: { id: true, name: true, slug: true, color: true, icon: true } },
  audiences: { select: { ageGroup: true } }, // étiquettes Enfants / Ados / Adultes
  instructors: { select: { user: { select: { firstName: true, lastName: true } } } },
};

router.get('/categories', optionalAuth, wrap(async (req, res) => {
  const audiences = visibleAudiences(req.user);
  const cats = await prisma.category.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: {
        select: {
          courses: { where: { isPublished: true, ...(audiences && { audiences: { some: { ageGroup: { in: audiences } } } }) } },
        },
      },
    },
  });
  res.json(cats.map(({ _count, ...c }) => ({ ...c, courseCount: _count.courses })));
}));

// Compteurs affichés sur les cartes (modules, leçons, évaluations), sans charger le contenu des leçons
const statsSelect = {
  modules: { select: { _count: { select: { assessments: true } }, chapters: { select: { _count: { select: { lessons: true } } } } } },
};

router.get('/courses', optionalAuth, wrap(async (req, res) => {
  const { category, level, language } = req.query;
  const audiences = visibleAudiences(req.user);
  const courses = await prisma.course.findMany({
    where: {
      isPublished: true,
      ...(category && { category: { slug: String(category) } }),
      ...(level && { level: String(level) }),
      ...(language && { language: String(language) }),
      ...(audiences && { audiences: { some: { ageGroup: { in: audiences } } } }),
    },
    select: { ...courseSummary, ...statsSelect },
    orderBy: { createdAt: 'desc' },
  });

  // Inscriptions de l'apprenant connecté (pour afficher « Continuer » et la progression)
  const mine = new Map();
  if (req.user?.role === 'learner' && courses.length) {
    const enrollments = await prisma.enrollment.findMany({
      where: { userId: req.user.id, courseId: { in: courses.map((c) => c.id) }, status: { not: 'cancelled' } },
    });
    await Promise.all(enrollments.map(async (e) => {
      mine.set(e.courseId, { id: e.id, status: e.status, progressPct: e.status === 'pending' ? 0 : await courseProgress(e.id, e.courseId) });
    }));
  }

  res.json(courses.map(({ modules, ...c }) => ({
    ...c,
    stats: {
      modules: modules.length,
      lessons: modules.reduce((n, m) => n + m.chapters.reduce((k, ch) => k + ch._count.lessons, 0), 0),
      quizzes: modules.reduce((n, m) => n + m._count.assessments, 0),
    },
    enrollment: mine.get(c.id) ?? null,
  })));
}));

// Détail : programme (modules, chapitres, titres de leçons — sans le contenu)
router.get('/courses/:slug', optionalAuth, wrap(async (req, res) => {
  const course = await prisma.course.findFirst({
    where: { slug: req.params.slug, isPublished: true },
    select: {
      ...courseSummary,
      sequentialUnlock: true,
      modules: {
        orderBy: { position: 'asc' },
        select: {
          id: true, title: true, description: true, position: true, imageUrl: true,
          chapters: {
            orderBy: { position: 'asc' },
            select: { id: true, title: true, position: true,
              lessons: { orderBy: { position: 'asc' }, select: { id: true, title: true, type: true, durationSec: true, position: true } } },
          },
          assessments: { orderBy: { position: 'asc' }, select: { id: true, title: true, type: true, isRequired: true } },
        },
      },
    },
  });
  if (!course) throw new HttpError(404, 'Formation introuvable');
  const allowed = visibleAudiences(req.user);
  if (allowed && !course.audiences.some((a) => allowed.includes(a.ageGroup))) {
    throw new HttpError(404, 'Formation introuvable'); // on ne révèle pas l'existence
  }
  res.json(course);
}));

export default router;
