import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { wrap, HttpError } from '../lib/http.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { isModuleUnlocked, recomputeModuleResult } from '../lib/progress.js';
import { requireActiveEnrollment } from './learn.js';
import { QUIZ_TYPES, parseAnswers, gradeAttempt, isExpired, deadlineOf } from '../lib/quiz.js';

// Passage des quiz par l'élève. La notation se fait ici, côté serveur.
// Avant la soumission : jamais de bonne réponse ni d'explication. Après : la note, puis les bonnes réponses et explications
// seulement quand le quiz est réussi ou que toutes les tentatives sont utilisées.
const router = Router();
router.use(requireAuth);

// Questions telles que l'élève les voit pendant le quiz : sans isCorrect ni explication
const studentQuestions = (assessmentId) => prisma.question.findMany({
  where: { assessmentId },
  orderBy: { position: 'asc' },
  select: { id: true, type: true, text: true, points: true, options: { orderBy: { position: 'asc' }, select: { id: true, text: true } } },
});

async function accessAssessment(user, assessmentId) {
  const assessment = await prisma.assessment.findUnique({ where: { id: assessmentId }, include: { module: { include: { course: true } } } });
  if (!assessment) throw new HttpError(404, 'Évaluation introuvable');
  if (!QUIZ_TYPES.includes(assessment.type)) throw new HttpError(400, 'Cette évaluation n\'est pas un quiz');
  const course = assessment.module.course;
  const enrollment = await requireActiveEnrollment(user.id, { courseId: course.id });
  if (!(await isModuleUnlocked(enrollment.id, course, assessment.module))) {
    throw new HttpError(403, 'Terminez le module précédent pour débloquer cette évaluation');
  }
  return { assessment, enrollment };
}

// Une tentative n'est visible que par son propriétaire (404 sinon, pour ne rien révéler)
async function loadOwnAttempt(userId, attemptId) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, include: { assessment: true, enrollment: true } });
  if (!attempt || attempt.enrollment.userId !== userId) throw new HttpError(404, 'Tentative introuvable');
  return attempt;
}

// Temps écoulé : la tentative est clôturée avec 0 %, sans réponses
async function closeExpired(attempt) {
  await prisma.attempt.updateMany({
    where: { id: attempt.id, status: 'in_progress' },
    data: { status: 'submitted', submittedAt: new Date(), scorePct: 0, passed: false },
  });
  await recomputeModuleResult(attempt.enrollmentId, attempt.assessment.moduleId);
}

const attemptInfo = (attempt, assessment) => ({
  id: attempt.id,
  attemptNo: attempt.attemptNo,
  startedAt: attempt.startedAt,
  deadline: deadlineOf(attempt.startedAt, assessment.timeLimitMin),
});

// Les bonnes réponses et les explications ne sont montrées qu'une fois le quiz réussi ou toutes les tentatives
// utilisées : sinon l'élève pourrait les mémoriser avant de recommencer. Entre-temps, il voit sa note et,
// pour chaque question, si sa réponse était juste ou fausse (mais pas la bonne réponse).
async function canRevealAnswers(assessment, enrollmentId) {
  const where = { assessmentId: assessment.id, enrollmentId, status: 'submitted' };
  const [passed, used] = await Promise.all([
    prisma.attempt.count({ where: { ...where, passed: true } }),
    prisma.attempt.count({ where }),
  ]);
  return passed > 0 || used >= assessment.maxAttempts;
}

// Correction d'une tentative terminée : choix de l'élève, résultat par question et, si `reveal`, bonnes réponses + explications
async function buildReview(attempt, reveal) {
  const [questions, answers] = await Promise.all([
    prisma.question.findMany({ where: { assessmentId: attempt.assessmentId }, orderBy: { position: 'asc' }, include: { options: { orderBy: { position: 'asc' } } } }),
    prisma.attemptAnswer.findMany({ where: { attemptId: attempt.id }, include: { selectedOptions: true } }),
  ]);
  const byQuestion = new Map(answers.map((a) => [a.questionId, a]));
  return questions.map((q) => {
    const a = byQuestion.get(q.id);
    const chosen = new Set((a?.selectedOptions ?? []).map((s) => s.optionId));
    return {
      id: q.id, type: q.type, text: q.text, points: q.points,
      ...(reveal && { explanation: q.explanation }),
      isCorrect: a?.isCorrect ?? false,
      pointsAwarded: Number(a?.pointsAwarded ?? 0),
      options: q.options.map((o) => ({ id: o.id, text: o.text, selected: chosen.has(o.id), ...(reveal && { isCorrect: o.isCorrect }) })),
    };
  });
}

// Fiche du quiz : consignes, seuil, tentatives restantes, historique
router.get('/assessments/:id', wrap(async (req, res) => {
  const { assessment, enrollment } = await accessAssessment(req.user, req.params.id);
  const [attempts, questionCount] = await Promise.all([
    prisma.attempt.findMany({
      where: { assessmentId: assessment.id, enrollmentId: enrollment.id }, orderBy: { attemptNo: 'asc' },
      select: { id: true, attemptNo: true, status: true, scorePct: true, passed: true, startedAt: true, submittedAt: true },
    }),
    prisma.question.count({ where: { assessmentId: assessment.id } }),
  ]);
  const scores = attempts.filter((a) => a.status === 'submitted').map((a) => Number(a.scorePct ?? 0));
  res.json({
    id: assessment.id, title: assessment.title, type: assessment.type, instructions: assessment.instructions,
    passMark: assessment.passMark, maxAttempts: assessment.maxAttempts, timeLimitMin: assessment.timeLimitMin,
    isRequired: assessment.isRequired, questionCount,
    attempts, attemptsLeft: Math.max(0, assessment.maxAttempts - attempts.length),
    passed: attempts.some((a) => a.passed === true),
    bestScorePct: scores.length ? Math.max(...scores) : null,
    inProgressAttemptId: attempts.find((a) => a.status === 'in_progress')?.id ?? null,
  });
}));

// Démarrer une tentative (ou reprendre celle en cours)
router.post('/assessments/:id/attempts', wrap(async (req, res) => {
  const { assessment, enrollment } = await accessAssessment(req.user, req.params.id);
  const questions = await studentQuestions(assessment.id);
  if (questions.length === 0) throw new HttpError(409, 'Ce quiz ne contient pas encore de questions');

  const where = { assessmentId: assessment.id, enrollmentId: enrollment.id };
  let current = await prisma.attempt.findFirst({ where: { ...where, status: 'in_progress' }, orderBy: { attemptNo: 'desc' } });
  if (current && isExpired(current.startedAt, assessment.timeLimitMin)) {
    await closeExpired({ ...current, assessment });
    current = null;
  }

  let created = false;
  if (!current) {
    const used = await prisma.attempt.count({ where });
    if (used >= assessment.maxAttempts) throw new HttpError(403, 'Nombre maximal de tentatives atteint');
    try {
      current = await prisma.attempt.create({ data: { ...where, attemptNo: used + 1 } });
      created = true;
    } catch (e) {
      // Double clic : une autre requête vient de créer la tentative, on la reprend
      if (e.code !== 'P2002') throw e;
      current = await prisma.attempt.findFirst({ where: { ...where, status: 'in_progress' }, orderBy: { attemptNo: 'desc' } });
      if (!current) throw new HttpError(409, 'Réessayez dans un instant');
    }
  }
  res.status(created ? 201 : 200).json({ attempt: attemptInfo(current, assessment), questions });
}));

const submitSchema = z.object({
  answers: z.array(z.object({
    questionId: z.string().uuid(),
    optionIds: z.array(z.string().uuid()).max(8),
  })).max(100),
});

// Soumettre : notation serveur, enregistrement, résultat du module, puis correction détaillée
router.post('/attempts/:id/submit', validate(submitSchema), wrap(async (req, res) => {
  const attempt = await loadOwnAttempt(req.user.id, req.params.id);
  const { assessment } = attempt;
  if (['pending', 'cancelled'].includes(attempt.enrollment.status)) throw new HttpError(403, 'Inscription inactive');
  if (attempt.status !== 'in_progress') throw new HttpError(409, 'Cette tentative est déjà terminée');

  if (isExpired(attempt.startedAt, assessment.timeLimitMin)) {
    await closeExpired(attempt);
    throw new HttpError(409, 'Temps écoulé : cette tentative est clôturée avec la note 0');
  }

  const questions = await prisma.question.findMany({ where: { assessmentId: assessment.id }, include: { options: true } });
  const graded = gradeAttempt(questions, parseAnswers(questions, req.body.answers));
  const passed = graded.scorePct >= assessment.passMark;

  await prisma.$transaction(async (tx) => {
    // Verrou : seule la première soumission passe (anti double envoi)
    const claimed = await tx.attempt.updateMany({
      where: { id: attempt.id, status: 'in_progress' },
      data: { status: 'submitted', submittedAt: new Date(), scorePct: graded.scorePct, passed },
    });
    if (claimed.count !== 1) throw new HttpError(409, 'Cette tentative est déjà terminée');
    const rows = graded.details.map((d) => ({ id: randomUUID(), attemptId: attempt.id, questionId: d.questionId, isCorrect: d.isCorrect, pointsAwarded: d.points }));
    await tx.attemptAnswer.createMany({ data: rows });
    const chosen = rows.flatMap((r, i) => graded.details[i].selected.map((optionId) => ({ attemptAnswerId: r.id, optionId })));
    if (chosen.length) await tx.attemptAnswerOption.createMany({ data: chosen });
  });

  const moduleResult = await recomputeModuleResult(attempt.enrollmentId, assessment.moduleId);
  const used = await prisma.attempt.count({ where: { assessmentId: assessment.id, enrollmentId: attempt.enrollmentId } });
  const reveal = await canRevealAnswers(assessment, attempt.enrollmentId);
  res.json({
    attempt: { id: attempt.id, attemptNo: attempt.attemptNo, scorePct: graded.scorePct, passed, passMark: assessment.passMark },
    attemptsLeft: Math.max(0, assessment.maxAttempts - used),
    moduleStatus: moduleResult.status,
    answersRevealed: reveal,
    questions: await buildReview(attempt, reveal),
  });
}));

// Reprendre une tentative en cours, ou relire la correction d'une tentative terminée
router.get('/attempts/:id', wrap(async (req, res) => {
  const attempt = await loadOwnAttempt(req.user.id, req.params.id);
  const { assessment } = attempt;
  if (attempt.status === 'in_progress') {
    return res.json({ attempt: attemptInfo(attempt, assessment), questions: await studentQuestions(assessment.id) });
  }
  const reveal = await canRevealAnswers(assessment, attempt.enrollmentId);
  res.json({
    attempt: { id: attempt.id, attemptNo: attempt.attemptNo, scorePct: Number(attempt.scorePct ?? 0), passed: attempt.passed, passMark: assessment.passMark, submittedAt: attempt.submittedAt },
    answersRevealed: reveal,
    questions: await buildReview(attempt, reveal),
  });
}));

export default router;
