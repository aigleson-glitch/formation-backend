import { prisma } from './prisma.js';

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
