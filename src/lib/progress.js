import { prisma } from './prisma.js';
import { moduleOutcome } from './quiz.js';

/**
 * Règle 2 : progression = (leçons terminées + évaluations réussies) / (total leçons + total évaluations)
 * Une évaluation est « réussie » si une tentative de quiz ou un devoir noté a passed = true.
 */
export async function courseProgress(enrollmentId, courseId) {
  const [totalLessons, totalAssessments, doneLessons, passedAttempts, passedSubs] = await Promise.all([
    prisma.lesson.count({ where: { chapter: { module: { courseId } } } }),
    prisma.assessment.count({ where: { module: { courseId } } }),
    prisma.lessonProgress.count({ where: { enrollmentId } }),
    prisma.attempt.findMany({ where: { enrollmentId, passed: true }, distinct: ['assessmentId'], select: { assessmentId: true } }),
    prisma.submission.findMany({ where: { enrollmentId, passed: true }, distinct: ['assessmentId'], select: { assessmentId: true } }),
  ]);
  const passed = new Set([...passedAttempts, ...passedSubs].map((x) => x.assessmentId)).size;
  const total = totalLessons + totalAssessments;
  return total === 0 ? 0 : Math.round(((doneLessons + passed) / total) * 100);
}

/**
 * Un module est « Compétent » (règle 5) si :
 *  - il a des évaluations obligatoires → son module_result est `competent` (calculé en phase 2/3) ;
 *  - sinon (phase 1, cours sans évaluation) → toutes ses leçons sont terminées.
 */
export async function isModuleCompetent(enrollmentId, module) {
  const requiredCount = await prisma.assessment.count({ where: { moduleId: module.id, isRequired: true } });
  if (requiredCount > 0) {
    const r = await prisma.moduleResult.findUnique({
      where: { enrollmentId_moduleId: { enrollmentId, moduleId: module.id } },
    });
    return r?.status === 'competent';
  }
  const lessons = await prisma.lesson.count({ where: { chapter: { moduleId: module.id } } });
  if (lessons === 0) return true;
  const done = await prisma.lessonProgress.count({ where: { enrollmentId, lesson: { chapter: { moduleId: module.id } } } });
  return done >= lessons;
}

/** Règle 3 : déblocage séquentiel (module N+1 ouvert quand N est compétent). */
export async function isModuleUnlocked(enrollmentId, course, module) {
  if (!course.sequentialUnlock) return true;
  const previous = await prisma.module.findFirst({
    where: { courseId: course.id, position: { lt: module.position } },
    orderBy: { position: 'desc' },
  });
  return previous ? isModuleCompetent(enrollmentId, previous) : true;
}

/**
 * Recalcule le résultat d'un module après une évaluation (règle 5) :
 * « compétent » quand toutes les évaluations obligatoires sont réussies (quiz ou devoir noté).
 * Le score du module est la moyenne des meilleures notes de quiz ; la date de réussite est conservée.
 */
export async function recomputeModuleResult(enrollmentId, moduleId) {
  const required = await prisma.assessment.findMany({ where: { moduleId, isRequired: true }, select: { id: true } });
  const ids = required.map((a) => a.id);
  const [attempts, subs, existing] = await Promise.all([
    prisma.attempt.findMany({
      where: { enrollmentId, assessmentId: { in: ids }, status: 'submitted' },
      select: { assessmentId: true, scorePct: true, passed: true },
    }),
    prisma.submission.findMany({ where: { enrollmentId, assessmentId: { in: ids }, passed: true }, select: { assessmentId: true } }),
    prisma.moduleResult.findUnique({ where: { enrollmentId_moduleId: { enrollmentId, moduleId } } }),
  ]);
  const passedIds = new Set([...attempts.filter((a) => a.passed).map((a) => a.assessmentId), ...subs.map((s) => s.assessmentId)]);
  const best = new Map();
  for (const a of attempts) {
    const score = Number(a.scorePct ?? 0);
    if (!best.has(a.assessmentId) || score > best.get(a.assessmentId)) best.set(a.assessmentId, score);
  }
  const { status, scorePct } = moduleOutcome(ids, passedIds, best);
  const completedAt = status === 'competent' ? (existing?.completedAt ?? new Date()) : null;
  const result = await prisma.moduleResult.upsert({
    where: { enrollmentId_moduleId: { enrollmentId, moduleId } },
    create: { enrollmentId, moduleId, status, scorePct, completedAt },
    update: { status, scorePct, completedAt },
  });
  // Un module vient peut-être d'être validé : c'était peut-être le dernier. Une panne ici ne doit pas faire
  // échouer l'envoi du quiz (la tentative est déjà enregistrée) : elle sera rattrapée à la prochaine action.
  await completeEnrollmentIfDone(enrollmentId).catch((e) => console.error('Fin de formation :', e.message));
  return result;
}

/**
 * Fin de formation : tous les modules sont « compétents » ET toutes les leçons sont terminées.
 * L'inscription passe alors à « completed » (avec la date). C'est définitif : un statut « terminée »
 * ne revient jamais en arrière, même si un quiz obligatoire est ajouté plus tard (le certificat en dépendra).
 * Retourne true si l'inscription est (ou vient de devenir) terminée.
 */
export async function completeEnrollmentIfDone(enrollmentId) {
  const e = await prisma.enrollment.findUnique({ where: { id: enrollmentId }, select: { id: true, courseId: true, status: true } });
  if (!e) return false;
  if (e.status === 'completed') return true;
  if (e.status !== 'active') return false; // en attente de paiement ou annulée

  const modules = await prisma.module.findMany({ where: { courseId: e.courseId }, orderBy: { position: 'asc' } });
  if (modules.length === 0) return false;

  const inCourse = { chapter: { module: { courseId: e.courseId } } };
  const [totalLessons, doneLessons] = await Promise.all([
    prisma.lesson.count({ where: inCourse }),
    prisma.lessonProgress.count({ where: { enrollmentId: e.id, lesson: inCourse } }),
  ]);
  if (doneLessons < totalLessons) return false;
  for (const m of modules) {
    if (!(await isModuleCompetent(e.id, m))) return false;
  }

  // Seule la première requête qui arrive ici écrit la date ; une autre, simultanée, ne change rien.
  await prisma.enrollment.updateMany({
    where: { id: e.id, status: 'active' },
    data: { status: 'completed', completedAt: new Date() },
  });
  return true;
}
