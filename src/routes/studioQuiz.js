import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { wrap, HttpError } from '../lib/http.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { assertOwnsCourse } from './studio.js';
import { QUIZ_TYPES, buildTrueFalseOptions, checkOptions } from '../lib/quiz.js';
import { recomputeModuleResult } from '../lib/progress.js';

// Gestion des quiz par le formateur de la formation (ou l'administrateur).
// Règle d'intégrité : dès qu'un élève a commencé le quiz, sa structure est figée
// (types, points, options, nombre de questions, seuil) ; seuls les textes restent corrigeables.
const router = Router();
router.use(requireAuth, requireRole('instructor', 'admin'));

const nextPosition = async (model, where) =>
  ((await prisma[model].aggregate({ where, _max: { position: true } }))._max.position ?? 0) + 1;

const FROZEN = 'Des élèves ont déjà passé ce quiz : seuls les textes et les explications peuvent être corrigés. Créez un nouveau quiz pour changer la structure.';

// ── Chargement avec contrôle des droits ───────────────────────
async function loadAssessment(user, id) {
  const assessment = await prisma.assessment.findUnique({ where: { id }, include: { module: { include: { course: true } } } });
  if (!assessment) throw new HttpError(404, 'Évaluation introuvable');
  await assertOwnsCourse(user, assessment.module.courseId);
  return assessment;
}
async function loadQuestion(user, id) {
  const question = await prisma.question.findUnique({ where: { id }, include: { options: true, assessment: { include: { module: { include: { course: true } } } } } });
  if (!question) throw new HttpError(404, 'Question introuvable');
  await assertOwnsCourse(user, question.assessment.module.courseId);
  return question;
}
const hasAttempts = async (assessmentId) => (await prisma.attempt.count({ where: { assessmentId } })) > 0;

// Quand les évaluations obligatoires d'un module changent (ajout, suppression, obligatoire ou non), le résultat
// « compétent / pas encore compétent » de chaque élève qui en a un est recalculé : sans cela il resterait périmé
// (ex. un élève resterait « compétent » alors qu'un quiz obligatoire vient d'être ajouté).
// Une panne ici ne doit pas annuler la modification déjà enregistrée : on la signale dans la réponse.
async function refreshModuleResults(moduleId) {
  try {
    const rows = await prisma.moduleResult.findMany({ where: { moduleId }, select: { enrollmentId: true } });
    for (const r of rows) await recomputeModuleResult(r.enrollmentId, moduleId);
    return { studentsRecalculated: rows.length };
  } catch (e) {
    console.error('Recalcul des résultats du module :', e.message);
    return { recalculationFailed: true };
  }
}

// ── Quiz ─────────────────────────────────────────────────────
const assessmentFields = {
  type: z.enum(['quiz', 'mcq']),
  title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().max(5000).nullable().optional(),
  passMark: z.number().int().min(0).max(100).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  timeLimitMin: z.number().int().min(1).max(240).nullable().optional(),
  isRequired: z.boolean().optional(),
};
const createAssessmentSchema = z.object(assessmentFields);
const updateAssessmentSchema = z.object(assessmentFields).omit({ type: true }).partial();

router.post('/modules/:id/assessments', validate(createAssessmentSchema), wrap(async (req, res) => {
  const mod = await prisma.module.findUnique({ where: { id: req.params.id }, include: { course: true } });
  if (!mod) throw new HttpError(404, 'Module introuvable');
  await assertOwnsCourse(req.user, mod.courseId);
  const b = req.body;
  const position = await nextPosition('assessment', { moduleId: mod.id });
  const created = await prisma.assessment.create({
    data: {
      moduleId: mod.id, position, type: b.type, title: b.title,
      instructions: b.instructions ?? null,
      passMark: b.passMark ?? mod.course.defaultPassMark,
      maxAttempts: b.maxAttempts ?? 3,
      timeLimitMin: b.timeLimitMin ?? null,
      isRequired: b.isRequired ?? true,
    },
  });
  const refresh = created.isRequired ? await refreshModuleResults(mod.id) : {};
  res.status(201).json({ ...created, ...refresh });
}));

// Vue complète du formateur : questions, options et bonnes réponses
router.get('/assessments/:id', wrap(async (req, res) => {
  const a = await loadAssessment(req.user, req.params.id);
  const [questions, attempts] = await Promise.all([
    prisma.question.findMany({ where: { assessmentId: a.id }, orderBy: { position: 'asc' }, include: { options: { orderBy: { position: 'asc' } } } }),
    prisma.attempt.count({ where: { assessmentId: a.id } }),
  ]);
  const { module, ...rest } = a;
  res.json({ ...rest, questions, attemptsCount: attempts, locked: attempts > 0 });
}));

router.patch('/assessments/:id', validate(updateAssessmentSchema), wrap(async (req, res) => {
  const a = await loadAssessment(req.user, req.params.id);
  if (req.body.passMark !== undefined && req.body.passMark !== a.passMark && (await hasAttempts(a.id))) {
    throw new HttpError(409, 'Le seuil de réussite ne peut plus changer : des élèves ont déjà passé ce quiz');
  }
  const updated = await prisma.assessment.update({ where: { id: a.id }, data: req.body });
  const requiredChanged = req.body.isRequired !== undefined && req.body.isRequired !== a.isRequired;
  const refresh = requiredChanged ? await refreshModuleResults(a.moduleId) : {};
  res.json({ ...updated, ...refresh });
}));

router.delete('/assessments/:id', wrap(async (req, res) => {
  const a = await loadAssessment(req.user, req.params.id);
  if (await hasAttempts(a.id)) throw new HttpError(409, 'Des élèves ont déjà passé ce quiz : il ne peut plus être supprimé');
  await prisma.assessment.delete({ where: { id: a.id } });
  if (a.isRequired) await refreshModuleResults(a.moduleId);
  res.status(204).end();
}));

// ── Questions ────────────────────────────────────────────────
const optionSchema = z.object({ text: z.string().trim().min(1).max(500), isCorrect: z.boolean() });
const questionCommon = {
  text: z.string().trim().min(1).max(2000),
  explanation: z.string().trim().max(2000).nullable().optional(),
  points: z.number().int().min(1).max(100).optional(),
};
const questionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('single'), ...questionCommon, options: z.array(optionSchema) }),
  z.object({ type: z.literal('multiple'), ...questionCommon, options: z.array(optionSchema) }),
  z.object({ type: z.literal('true_false'), ...questionCommon, correctAnswer: z.boolean() }),
]);

router.post('/assessments/:id/questions', validate(questionSchema), wrap(async (req, res) => {
  const a = await loadAssessment(req.user, req.params.id);
  if (!QUIZ_TYPES.includes(a.type)) throw new HttpError(400, 'Cette évaluation n\'est pas un quiz');
  if (await hasAttempts(a.id)) throw new HttpError(409, FROZEN);
  const b = req.body;
  const options = b.type === 'true_false' ? buildTrueFalseOptions(b.correctAnswer, a.module.course.language) : b.options;
  const problem = checkOptions(b.type, options);
  if (problem) throw new HttpError(422, problem);
  const position = await nextPosition('question', { assessmentId: a.id });
  const question = await prisma.question.create({
    data: {
      assessmentId: a.id, position, type: b.type, text: b.text,
      explanation: b.explanation ?? null, points: b.points ?? 1,
      options: { create: options.map((o, i) => ({ text: o.text, isCorrect: o.isCorrect, position: i + 1 })) },
    },
    include: { options: { orderBy: { position: 'asc' } } },
  });
  res.status(201).json(question);
}));

const updateQuestionSchema = z.object({
  text: questionCommon.text.optional(),
  explanation: questionCommon.explanation,
  points: questionCommon.points,
  options: z.array(optionSchema).optional(),
  correctAnswer: z.boolean().optional(),
});

router.patch('/questions/:id', validate(updateQuestionSchema), wrap(async (req, res) => {
  const q = await loadQuestion(req.user, req.params.id);
  const { text, explanation, points, options, correctAnswer } = req.body;
  const structural = points !== undefined || options !== undefined || correctAnswer !== undefined;
  if (structural && (await hasAttempts(q.assessmentId))) throw new HttpError(409, FROZEN);

  if (options !== undefined) {
    if (q.type === 'true_false') throw new HttpError(400, 'Pour une question vrai/faux, utilisez correctAnswer');
    const problem = checkOptions(q.type, options);
    if (problem) throw new HttpError(422, problem);
  }
  if (correctAnswer !== undefined && q.type !== 'true_false') throw new HttpError(400, 'correctAnswer concerne seulement les questions vrai/faux');

  await prisma.$transaction(async (tx) => {
    await tx.question.update({
      where: { id: q.id },
      data: { ...(text !== undefined && { text }), ...(explanation !== undefined && { explanation }), ...(points !== undefined && { points }) },
    });
    if (options !== undefined) {
      await tx.questionOption.deleteMany({ where: { questionId: q.id } });
      await tx.questionOption.createMany({ data: options.map((o, i) => ({ questionId: q.id, text: o.text, isCorrect: o.isCorrect, position: i + 1 })) });
    }
    if (correctAnswer !== undefined) {
      await tx.questionOption.updateMany({ where: { questionId: q.id, position: 1 }, data: { isCorrect: correctAnswer } });
      await tx.questionOption.updateMany({ where: { questionId: q.id, position: 2 }, data: { isCorrect: !correctAnswer } });
    }
  });
  res.json(await prisma.question.findUnique({ where: { id: q.id }, include: { options: { orderBy: { position: 'asc' } } } }));
}));

router.delete('/questions/:id', wrap(async (req, res) => {
  const q = await loadQuestion(req.user, req.params.id);
  if (await hasAttempts(q.assessmentId)) throw new HttpError(409, FROZEN);
  await prisma.question.delete({ where: { id: q.id } });
  res.status(204).end();
}));

export default router;
