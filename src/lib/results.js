import { QUIZ_TYPES, moduleOutcome } from './quiz.js';

// Résultats d'un élève, par formation puis par module (fonction pure : aucune requête, facile à tester).
// Le statut d'un module suit exactement la règle qui verrouille ou déverrouille la suite (voir isModuleCompetent) :
//  - il y a des évaluations obligatoires → « Compétent » quand le résultat enregistré du module le dit ;
//  - sinon → « Compétent » quand toutes les leçons du module sont terminées.
// Le score du module est la moyenne des meilleures notes des évaluations obligatoires déjà tentées.

const num = (v) => (v === null || v === undefined ? null : Number(v));
const OPEN = ['submitted', 'in_review'];

function groupBy(list, keyOf) {
  const map = new Map();
  for (const item of list) {
    const key = keyOf(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

// Une évaluation vue par l'élève : sa note, ses tentatives, et où il en est
function summarize(assessment, attempts, submissions) {
  const isQuiz = QUIZ_TYPES.includes(assessment.type);
  let state;
  let passed;
  let attemptsUsed;
  let scores;

  if (isQuiz) {
    const done = attempts.filter((t) => t.status === 'submitted');
    passed = done.some((t) => t.passed === true);
    attemptsUsed = done.length;
    scores = done.map((t) => num(t.scorePct)).filter((s) => s !== null);
    if (passed) state = 'passed';
    else if (done.length > 0) state = 'failed';
    else if (attempts.some((t) => t.status === 'in_progress')) state = 'in_progress';
    else state = 'none';
  } else {
    const graded = submissions.filter((s) => s.status === 'graded');
    passed = graded.some((s) => s.passed === true);
    // Une copie renvoyée « à refaire » ne consomme pas de remise
    attemptsUsed = submissions.filter((s) => s.status !== 'resubmit').length;
    scores = graded.map((s) => num(s.scorePct)).filter((s) => s !== null);
    const latest = [...submissions].sort((a, b) => b.attemptNo - a.attemptNo)[0];
    if (passed) state = 'passed';
    else if (!latest) state = 'none';
    else if (OPEN.includes(latest.status)) state = 'pending';
    else if (latest.status === 'resubmit') state = 'resubmit';
    else state = 'failed';
  }

  return {
    id: assessment.id,
    title: assessment.title,
    type: assessment.type,
    kind: isQuiz ? 'quiz' : 'assignment',
    isRequired: assessment.isRequired,
    passMark: assessment.passMark,
    maxAttempts: assessment.maxAttempts,
    attemptsUsed,
    bestScorePct: scores.length ? Math.max(...scores) : null,
    passed,
    state,
  };
}

export function buildResults({ enrollments, modules, assessments, lessons, lessonProgress, attempts, submissions, moduleResults }) {
  const modulesByCourse = groupBy(modules, (m) => m.courseId);
  const assessmentsByModule = groupBy(assessments, (a) => a.moduleId);
  const lessonsByModule = groupBy(lessons, (l) => l.moduleId);
  const progressByEnrollment = groupBy(lessonProgress, (p) => p.enrollmentId);
  const attemptsByKey = groupBy(attempts, (t) => `${t.enrollmentId}:${t.assessmentId}`);
  const submissionsByKey = groupBy(submissions, (s) => `${s.enrollmentId}:${s.assessmentId}`);
  const resultByKey = new Map(moduleResults.map((r) => [`${r.enrollmentId}:${r.moduleId}`, r]));

  return enrollments.map((e) => {
    const doneLessons = new Set((progressByEnrollment.get(e.id) ?? []).map((p) => p.lessonId));
    const courseModules = [...(modulesByCourse.get(e.course.id) ?? [])].sort((a, b) => a.position - b.position);

    return {
      course: { id: e.course.id, title: e.course.title, slug: e.course.slug },
      enrollmentStatus: e.status,
      modules: courseModules.map((m) => {
        const own = [...(assessmentsByModule.get(m.id) ?? [])].sort((a, b) => a.position - b.position);
        const items = own.map((a) => summarize(a, attemptsByKey.get(`${e.id}:${a.id}`) ?? [], submissionsByKey.get(`${e.id}:${a.id}`) ?? []));
        const required = items.filter((i) => i.isRequired);

        const lessonIds = (lessonsByModule.get(m.id) ?? []).map((l) => l.id);
        const lessonsDone = lessonIds.filter((id) => doneLessons.has(id)).length;

        const passedIds = new Set(required.filter((i) => i.passed).map((i) => i.id));
        const best = new Map(required.filter((i) => i.bestScorePct !== null).map((i) => [i.id, i.bestScorePct]));
        const { scorePct } = moduleOutcome(required.map((i) => i.id), passedIds, best);

        const stored = resultByKey.get(`${e.id}:${m.id}`);
        const basis = required.length > 0 ? 'evaluations' : 'lessons';
        const competent = basis === 'evaluations'
          ? stored?.status === 'competent'
          : lessonIds.length === 0 || lessonsDone >= lessonIds.length;

        return {
          id: m.id,
          title: m.title,
          position: m.position,
          status: competent ? 'competent' : 'not_yet',
          basis,
          scorePct,
          lessons: { done: lessonsDone, total: lessonIds.length },
          requiredCount: required.length,
          passedCount: passedIds.size,
          assessments: items,
        };
      }),
    };
  });
}
