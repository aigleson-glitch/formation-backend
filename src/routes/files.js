import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma.js';
import { wrap, HttpError } from '../lib/http.js';
import { requireAuth, isActiveGuardian } from '../middleware/auth.js';
import { submitDecision } from '../lib/assignmentRules.js';
import { checkUpload, fileView, contentDisposition, MAX_UPLOAD_BYTES, MAX_PENDING_FILES } from '../lib/uploadRules.js';
import { saveBytes, removeBytes, openStream, exists, cleanupOrphans } from '../lib/fileStore.js';
import { accessAssignment } from './assignment.js';

// Fichiers joints aux copies (PDF, Word, image, ZIP) : envoi par l'élève, téléchargement par les personnes autorisées.
//   PUT    /assignments/:id/files   corps = fichier brut ; en-tête X-File-Name = nom (encodé avec encodeURIComponent)
//   GET    /files/:id               téléchargement (toujours en « pièce jointe », jamais affiché dans le navigateur)
//   DELETE /files/:id               l'élève retire un fichier qu'il n'a pas encore rendu
// Un fichier s'envoie seul, puis se rattache à la remise : POST /assignments/:id/submissions { fileId }.
const router = Router();
router.use(requireAuth);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Trop d\'envois de fichiers. Réessayez dans quelques minutes.' },
});

// Droits et état du devoir vérifiés AVANT de lire le fichier : un élève qui ne peut pas rendre ce devoir n'envoie rien
const checkCanUpload = wrap(async (req, _res, next) => {
  const ctx = await accessAssignment(req.user, req.params.id);
  const subs = await prisma.submission.findMany({
    where: { assessmentId: ctx.assessment.id, enrollmentId: ctx.enrollment.id },
    select: { status: true, passed: true },
  });
  const decision = submitDecision({ maxAttempts: ctx.assessment.maxAttempts, submissions: subs });
  if (!decision.ok) throw new HttpError(decision.status, decision.message);
  const pending = await prisma.submissionFile.count({ where: { ownerId: req.user.id, assessmentId: ctx.assessment.id, submissionId: null } });
  if (pending >= MAX_PENDING_FILES) throw new HttpError(429, 'Trop de fichiers en attente : retirez-en ou rendez votre devoir');
  req.uploadCtx = ctx;
  next();
});

const rawBody = (req, res, next) =>
  express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES })(req, res, (err) => {
    if (err?.type === 'entity.too.large') return next(new HttpError(413, `Fichier trop volumineux (${Math.round(MAX_UPLOAD_BYTES / 1048576)} Mo au maximum)`));
    next(err);
  });

router.put('/assignments/:id/files', uploadLimiter, checkCanUpload, rawBody, wrap(async (req, res) => {
  const check = checkUpload({ buffer: req.body, fileName: req.get('x-file-name') });
  if (!check.ok) throw new HttpError(check.status, check.message);
  await cleanupOrphans();
  const key = await saveBytes(req.body);
  try {
    const row = await prisma.submissionFile.create({
      data: {
        ownerId: req.user.id, assessmentId: req.uploadCtx.assessment.id, originalName: check.name,
        mimeType: check.mime, sizeBytes: req.body.length, storageKey: key,
      },
    });
    res.status(201).json(fileView(row));
  } catch (e) {
    await removeBytes(key).catch(() => {});
    throw e;
  }
}));

// Qui peut télécharger : le propriétaire ; pour un fichier rendu, aussi le formateur du cours, l'admin et le parent actif.
async function canRead(user, file) {
  if (file.ownerId === user.id) return true;
  if (!file.submissionId) return false; // brouillon : visible de son seul propriétaire
  if (user.role === 'admin') return true;
  if (user.role === 'parent') return isActiveGuardian(user.id, file.ownerId);
  if (user.role === 'instructor') {
    const a = await prisma.assessment.findUnique({ where: { id: file.assessmentId }, select: { module: { select: { courseId: true } } } });
    if (!a) return false;
    return !!(await prisma.courseInstructor.findUnique({ where: { courseId_userId: { courseId: a.module.courseId, userId: user.id } } }));
  }
  return false;
}

router.get('/files/:id', wrap(async (req, res) => {
  const file = UUID.test(req.params.id) ? await prisma.submissionFile.findUnique({ where: { id: req.params.id } }) : null;
  // 404 dans tous les cas de refus : on ne révèle pas l'existence d'un fichier à qui n'y a pas droit
  if (!file || !(await canRead(req.user, file))) throw new HttpError(404, 'Fichier introuvable');
  if (!(await exists(file.storageKey))) throw new HttpError(410, 'Ce fichier n\'est plus disponible');
  res.set({
    'Content-Type': file.mimeType,
    'Content-Length': String(file.sizeBytes),
    'Content-Disposition': contentDisposition(file.originalName),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
  const stream = openStream(file.storageKey);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}));

router.delete('/files/:id', wrap(async (req, res) => {
  const file = UUID.test(req.params.id) ? await prisma.submissionFile.findUnique({ where: { id: req.params.id } }) : null;
  if (!file || file.ownerId !== req.user.id) throw new HttpError(404, 'Fichier introuvable');
  if (file.submissionId) throw new HttpError(409, 'Ce fichier fait partie d\'un devoir rendu : il ne peut plus être retiré');
  const gone = await prisma.submissionFile.deleteMany({ where: { id: file.id, submissionId: null } });
  if (gone.count > 0) await removeBytes(file.storageKey).catch(() => {});
  res.status(204).end();
}));

export default router;
