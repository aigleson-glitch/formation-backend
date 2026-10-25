import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { wrap, HttpError } from '../lib/http.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { isModuleUnlocked } from '../lib/progress.js';
import { requireActiveEnrollment } from './learn.js';
import { ASSIGNMENT_TYPES, contentProblem, submitDecision } from '../lib/assignmentRules.js';

// Devoirs : côté élève. L'élève dépose un texte et/ou un lien (https) ; le formateur corrige (routes /studio/submissions).
// La note, le commentaire et le statut « corrigé » n'apparaissent qu'une fois la correction faite.
const router = Router();
router.use(requireAuth);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function accessAssignment(user, id) {
  if (!UUID.test(id)) throw new HttpError(404, 'Devoir introuvable');
  const assessment = await prisma.assessment.findUnique({ where: { id }, include: { module: { include: { course: true } } } });
  if (!assessment || !ASSIGNMENT_TYPES.includes(assessment.type)) throw new HttpError(404, 'Devoir introuvable');
  const course = assessment.module.course;
  if (!course.isPublished) throw new HttpError(404, 'Devoir introuvable');
  const enrollment = await requireActiveEnrollment(user.id, { courseId: course.id });
  if (!(await isModuleUnlocked(enrollment.id, course, assessment.module))) {
    throw new HttpError(403, 'Terminez le module précédent pour débloquer ce devoir');
  }
  return { assessment, enrollment };
}

// Ce que l'élève voit de ses propres copies : la note et le commentaire seulement une fois corrigés
export function ownSubmissionView(s) {
  const corrected = s.status === 'graded' || s.status === 'resubmit';
  return {
    id: s.id, attemptNo: s.attemptNo, status: s.status, submittedAt: s.submittedAt,
    content: s.content, linkUrl: s.linkUrl,
    ...(corrected && { scorePct: s.scorePct === null ? null : Number(s.scorePct), passed: s.passed, feedback: s.feedback, gradedAt: s.gradedAt }),
  };
}

router.get('/assignments/:id', wrap(async (req, res) => {
  const { assessment, enrollment } = await accessAssignment(req.user, req.params.id);
  const subs = await prisma.submission.findMany({
    where: { assessmentId: assessment.id, enrollmentId: enrollment.id },
    orderBy: { attemptNo: 'asc' },
  });
  const decision = submitDecision({ maxAttempts: assessment.maxAttempts, submissions: subs });
  res.json({
    id: assessment.id, title: assessment.title, type: assessment.type, instructions: assessment.instructions,
    attachment: assessment.attachmentUrl ? { url: assessment.attachmentUrl, name: assessment.attachmentName } : null,
    passMark: assessment.passMark, maxAttempts: assessment.maxAttempts, isRequired: assessment.isRequired,
    attemptsLeft: decision.ok ? decision.attemptsLeft : 0,
    canSubmit: decision.ok,
    ...(decision.ok ? {} : { reason: decision.message }),
    submissions: subs.map(ownSubmissionView),
  });
}));

const submitSchema = z.object({
  content: z.string().max(20500).nullable().optional(),
  linkUrl: z.string().max(2100).nullable().optional(),
});

router.post('/assignments/:id/submissions', validate(submitSchema), wrap(async (req, res) => {
  const { assessment, enrollment } = await accessAssignment(req.user, req.params.id);
  const problem = contentProblem(req.body);
  if (problem) throw new HttpError(422, problem);

  const subs = await prisma.submission.findMany({
    where: { assessmentId: assessment.id, enrollmentId: enrollment.id },
    select: { attemptNo: true, status: true, passed: true },
  });
  const decision = submitDecision({ maxAttempts: assessment.maxAttempts, submissions: subs });
  if (!decision.ok) throw new HttpError(decision.status, decision.message);

  const attemptNo = subs.reduce((m, s) => Math.max(m, s.attemptNo), 0) + 1;
  try {
    const created = await prisma.submission.create({
      data: {
        assessmentId: assessment.id, enrollmentId: enrollment.id, attemptNo,
        content: req.body.content?.trim() || null, linkUrl: req.body.linkUrl?.trim() || null,
      },
    });
    res.status(201).json(ownSubmissionView(created));
  } catch (e) {
    // Deux envois simultanés : la contrainte d'unicité (devoir, inscription, n° de tentative) n'en laisse passer qu'un
    if (e.code === 'P2002') throw new HttpError(409, 'Votre devoir vient déjà d\'être envoyé');
    throw e;
  }
}));

export default router;
