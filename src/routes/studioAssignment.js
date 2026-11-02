import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { wrap, HttpError } from '../lib/http.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { assertOwnsCourse } from '../lib/studioAccess.js';
import { recomputeModuleResult } from '../lib/progress.js';
import { ASSIGNMENT_TYPES, OPEN_STATUSES, gradeProblem, isPassed, canRegrade, attachmentProblem } from '../lib/assignmentRules.js';
import { fileView } from '../lib/uploadRules.js';
import { removeBytes } from '../lib/fileStore.js';

// Devoirs : côté formateur (création des devoirs, file de correction, correction).
// Monté AVANT les routes de quiz : celles-ci ne comptent que les tentatives de quiz et laisseraient supprimer
// un devoir déjà rendu. Ici, tout ce qui touche un devoir passe par ces routes.
const router = Router();
router.use(requireAuth, requireRole('instructor', 'admin'));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nextPosition = async (where) =>
  ((await prisma.assessment.aggregate({ where, _max: { position: true } }))._max.position ?? 0) + 1;

async function loadAssignment(user, id) {
  if (!UUID.test(id)) throw new HttpError(404, 'Devoir introuvable');
  const a = await prisma.assessment.findUnique({ where: { id }, include: { module: { include: { course: true } } } });
  if (!a || !ASSIGNMENT_TYPES.includes(a.type)) throw new HttpError(404, 'Devoir introuvable');
  await assertOwnsCourse(user, a.module.courseId);
  return a;
}

// Un module dont les évaluations obligatoires changent : on recalcule les élèves déjà suivis (même logique que pour les quiz)
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

// ── Garde : un devoir ne se modifie pas par les routes de quiz ──
router.use('/assessments/:id', wrap(async (req, _res, next) => {
  if (UUID.test(req.params.id)) {
    const a = await prisma.assessment.findUnique({ where: { id: req.params.id }, select: { type: true } });
    if (a && ASSIGNMENT_TYPES.includes(a.type)) throw new HttpError(400, 'Ceci est un devoir : utilisez /studio/assignments/:id');
  }
  next();
}));

// ── Création et gestion des devoirs ──────────────────────────
const fields = {
  type: z.enum(['assignment', 'portfolio']).default('assignment'),
  title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().max(10000).nullable().optional(),
  attachmentUrl: z.string().trim().max(2100).nullable().optional(), // sujet PDF à télécharger (lien https)
  attachmentName: z.string().trim().max(250).nullable().optional(),
  passMark: z.number().int().min(0).max(100).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  isRequired: z.boolean().optional(),
};
const createSchema = z.object(fields);
const updateSchema = z.object(fields).omit({ type: true }).partial();

router.post('/modules/:id/assignments', validate(createSchema), wrap(async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'Module introuvable');
  const mod = await prisma.module.findUnique({ where: { id: req.params.id }, include: { course: true } });
  if (!mod) throw new HttpError(404, 'Module introuvable');
  await assertOwnsCourse(req.user, mod.courseId);
  const b = req.body;
  const fileProblem = attachmentProblem(b);
  if (fileProblem) throw new HttpError(422, fileProblem);
  const created = await prisma.assessment.create({
    data: {
      moduleId: mod.id, position: await nextPosition({ moduleId: mod.id }), type: b.type, title: b.title,
      instructions: b.instructions ?? null,
      attachmentUrl: b.attachmentUrl?.trim() || null,
      attachmentName: b.attachmentUrl?.trim() ? (b.attachmentName?.trim() || null) : null,
      passMark: b.passMark ?? mod.course.defaultPassMark,
      maxAttempts: b.maxAttempts ?? 3,
      isRequired: b.isRequired ?? true,
    },
  });
  // Un devoir obligatoire ajouté après coup : les élèves du module repassent « pas encore compétents » (comme pour un quiz)
  const refresh = created.isRequired ? await refreshModuleResults(mod.id) : {};
  res.status(201).json({ ...created, ...refresh });
}));

router.get('/assignments/:id', wrap(async (req, res) => {
  const a = await loadAssignment(req.user, req.params.id);
  const [submissionsCount, toGrade] = await Promise.all([
    prisma.submission.count({ where: { assessmentId: a.id } }),
    prisma.submission.count({ where: { assessmentId: a.id, status: { in: OPEN_STATUSES } } }),
  ]);
  const { module, ...rest } = a;
  res.json({ ...rest, submissionsCount, toGrade, locked: submissionsCount > 0 });
}));

router.patch('/assignments/:id', validate(updateSchema), wrap(async (req, res) => {
  const a = await loadAssignment(req.user, req.params.id);
  const started = (await prisma.submission.count({ where: { assessmentId: a.id } })) > 0;
  if (started && req.body.passMark !== undefined && req.body.passMark !== a.passMark) {
    throw new HttpError(409, 'Le seuil de réussite ne peut plus changer : des élèves ont déjà rendu ce devoir');
  }
  // Le sujet joint : on valide l'état final (ce qui est envoyé, complété par ce qui existe déjà)
  const data = { ...req.body };
  if ('attachmentUrl' in req.body || 'attachmentName' in req.body) {
    const url = 'attachmentUrl' in req.body ? (req.body.attachmentUrl?.trim() || null) : a.attachmentUrl;
    // Retirer le lien sans envoyer de nouveau nom retire aussi l'ancien nom ; envoyer un nom sans lien reste une erreur
    const keepOldName = !('attachmentUrl' in req.body) || url;
    const name = 'attachmentName' in req.body ? (req.body.attachmentName?.trim() || null) : (keepOldName ? a.attachmentName : null);
    const fileProblem = attachmentProblem({ attachmentUrl: url, attachmentName: name });
    if (fileProblem) throw new HttpError(422, fileProblem);
    data.attachmentUrl = url;
    data.attachmentName = url ? name : null; // retirer le lien retire aussi le nom
    if (url && a.attachmentKey) Object.assign(data, { attachmentKey: null, attachmentMime: null, attachmentSize: null }); // un lien remplace le fichier
  }
  const updated = await prisma.assessment.update({ where: { id: a.id }, data });
  if (data.attachmentKey === null && a.attachmentKey) await removeBytes(a.attachmentKey).catch(() => {});
  const requiredChanged = req.body.isRequired !== undefined && req.body.isRequired !== a.isRequired;
  const refresh = requiredChanged ? await refreshModuleResults(a.moduleId) : {};
  res.json({ ...updated, ...refresh });
}));

router.delete('/assignments/:id', wrap(async (req, res) => {
  const a = await loadAssignment(req.user, req.params.id);
  if ((await prisma.submission.count({ where: { assessmentId: a.id } })) > 0) {
    throw new HttpError(409, 'Des élèves ont déjà rendu ce devoir : il ne peut plus être supprimé');
  }
  await prisma.assessment.delete({ where: { id: a.id } });
  if (a.attachmentKey) await removeBytes(a.attachmentKey).catch(() => {});
  if (a.isRequired) await refreshModuleResults(a.moduleId);
  res.status(204).end();
}));

// ── File de correction ───────────────────────────────────────
const queueQuery = z.object({
  status: z.enum(['open', 'submitted', 'in_review', 'graded', 'resubmit']).default('open'),
  courseId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

router.get('/submissions', wrap(async (req, res) => {
  const q = queueQuery.safeParse(req.query);
  if (!q.success) throw new HttpError(400, 'Paramètres invalides');
  const { status, courseId, page, pageSize } = q.data;
  const where = {
    status: status === 'open' ? { in: OPEN_STATUSES } : status,
    assessment: {
      module: {
        ...(courseId && { courseId }),
        // Un formateur ne voit que les copies des formations qui lui sont affectées ; l'admin voit tout
        course: req.user.role === 'admin' ? {} : { instructors: { some: { userId: req.user.id } } },
      },
    },
  };
  const [total, rows] = await Promise.all([
    prisma.submission.count({ where }),
    prisma.submission.findMany({
      where, orderBy: { submittedAt: status === 'open' ? 'asc' : 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
      select: {
        id: true, attemptNo: true, status: true, submittedAt: true, scorePct: true, passed: true,
        file: { select: { id: true } },
        assessment: { select: { id: true, title: true, module: { select: { title: true, course: { select: { id: true, title: true } } } } } },
        enrollment: { select: { user: { select: { id: true, firstName: true, lastName: true, ageGroup: true } } } },
      },
    }),
  ]);
  res.json({
    page, pageSize, total,
    items: rows.map((s) => ({
      id: s.id, attemptNo: s.attemptNo, status: s.status, submittedAt: s.submittedAt, hasFile: !!s.file,
      scorePct: s.scorePct === null ? null : Number(s.scorePct), passed: s.passed,
      assignment: { id: s.assessment.id, title: s.assessment.title },
      module: s.assessment.module.title, course: s.assessment.module.course,
      student: s.enrollment.user,
    })),
  });
}));

async function loadSubmission(user, id) {
  if (!UUID.test(id)) throw new HttpError(404, 'Copie introuvable');
  const s = await prisma.submission.findUnique({
    where: { id },
    include: { assessment: { include: { module: { include: { course: true } } } }, enrollment: { include: { user: true } }, file: true },
  });
  if (!s) throw new HttpError(404, 'Copie introuvable');
  await assertOwnsCourse(user, s.assessment.module.courseId);
  return s;
}

router.get('/submissions/:id', wrap(async (req, res) => {
  const s = await loadSubmission(req.user, req.params.id);
  const history = await prisma.submission.findMany({
    where: { assessmentId: s.assessmentId, enrollmentId: s.enrollmentId, id: { not: s.id } },
    orderBy: { attemptNo: 'asc' },
    select: { id: true, attemptNo: true, status: true, scorePct: true, passed: true, submittedAt: true },
  });
  const u = s.enrollment.user;
  res.json({
    id: s.id, attemptNo: s.attemptNo, status: s.status, submittedAt: s.submittedAt,
    content: s.content, linkUrl: s.linkUrl, file: fileView(s.file),
    scorePct: s.scorePct === null ? null : Number(s.scorePct), passed: s.passed, feedback: s.feedback, gradedAt: s.gradedAt, graderId: s.graderId,
    assignment: { id: s.assessment.id, title: s.assessment.title, instructions: s.assessment.instructions, passMark: s.assessment.passMark },
    course: { id: s.assessment.module.course.id, title: s.assessment.module.course.title },
    student: { id: u.id, firstName: u.firstName, lastName: u.lastName, ageGroup: u.ageGroup },
    history: history.map((h) => ({ ...h, scorePct: h.scorePct === null ? null : Number(h.scorePct) })),
  });
}));

// Le formateur annonce qu'il prend la copie (statut « En correction »)
router.post('/submissions/:id/start-review', wrap(async (req, res) => {
  const s = await loadSubmission(req.user, req.params.id);
  if (s.status === 'submitted') {
    await prisma.submission.updateMany({ where: { id: s.id, status: 'submitted' }, data: { status: 'in_review', graderId: req.user.id } });
  } else if (s.status !== 'in_review') {
    throw new HttpError(409, 'Cette copie est déjà corrigée');
  }
  const fresh = await prisma.submission.findUnique({ where: { id: s.id }, select: { status: true, graderId: true } });
  res.json(fresh);
}));

const gradeSchema = z.object({
  decision: z.enum(['graded', 'resubmit']),
  scorePct: z.number().min(0).max(100).optional(),
  feedback: z.string().max(10000).optional(),
});

router.post('/submissions/:id/grade', validate(gradeSchema), wrap(async (req, res) => {
  const s = await loadSubmission(req.user, req.params.id);
  const { decision, scorePct, feedback } = req.body;
  const problem = gradeProblem({ decision, scorePct, feedback });
  if (problem) throw new HttpError(422, problem);

  // Première correction : copie en attente. Révision : copie déjà corrigée, tant qu'aucune copie plus récente n'existe.
  const isFirst = OPEN_STATUSES.includes(s.status);
  if (!isFirst) {
    const latest = await prisma.submission.aggregate({ where: { assessmentId: s.assessmentId, enrollmentId: s.enrollmentId }, _max: { attemptNo: true } });
    if (!canRegrade(s, latest._max.attemptNo)) throw new HttpError(409, 'Cette copie ne peut plus être corrigée : l\'élève a rendu une version plus récente ou doit la refaire');
  }

  const passed = decision === 'graded' ? isPassed(scorePct, s.assessment.passMark) : false;
  const done = await prisma.submission.updateMany({
    // Garde contre deux corrections simultanées : on n'écrit que si le statut n'a pas changé entre-temps
    where: { id: s.id, status: s.status },
    data: {
      status: decision, scorePct: decision === 'graded' ? scorePct : null, passed,
      feedback: feedback.trim(), graderId: req.user.id, gradedAt: new Date(),
    },
  });
  if (done.count === 0) throw new HttpError(409, 'Cette copie vient d\'être modifiée par quelqu\'un d\'autre : rechargez-la');

  // Le résultat du module (et la fin de formation) dépendent de la réussite : recalcul immédiat.
  let recalculationFailed;
  try { await recomputeModuleResult(s.enrollmentId, s.assessment.moduleId); }
  catch (e) { console.error('Recalcul après correction :', e.message); recalculationFailed = true; }

  const out = await prisma.submission.findUnique({ where: { id: s.id } });
  res.json({
    id: out.id, status: out.status, scorePct: out.scorePct === null ? null : Number(out.scorePct),
    passed: out.passed, feedback: out.feedback, gradedAt: out.gradedAt,
    ...(recalculationFailed && { recalculationFailed }),
  });
}));

export default router;
