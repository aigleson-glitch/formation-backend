import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma.js';
import { wrap, HttpError } from '../lib/http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { assertOwnsCourse } from '../lib/studioAccess.js';
import { accessAssignment } from './assignment.js';
import { ASSIGNMENT_TYPES } from '../lib/assignmentRules.js';
import { checkUpload, contentDisposition, MAX_UPLOAD_BYTES } from '../lib/uploadRules.js';
import { saveBytes, removeBytes, openStream, exists } from '../lib/fileStore.js';

// Sujet d'un devoir envoyé par le formateur (un seul fichier ; il remplace le lien https s'il y en avait un).
//   PUT    /studio/assignments/:id/subject   corps = fichier brut, en-tête X-File-Name (encodeURIComponent)
//   DELETE /studio/assignments/:id/subject   retire le fichier
//   GET    /assignments/:id/subject          téléchargement : élève inscrit (module débloqué), formateur du cours, admin
const router = Router();
router.use(requireAuth);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Trop d\'envois de fichiers. Réessayez dans quelques minutes.' },
});

async function loadOwned(user, id) {
  if (!UUID.test(id)) throw new HttpError(404, 'Devoir introuvable');
  const a = await prisma.assessment.findUnique({ where: { id }, include: { module: { select: { courseId: true } } } });
  if (!a || !ASSIGNMENT_TYPES.includes(a.type)) throw new HttpError(404, 'Devoir introuvable');
  await assertOwnsCourse(user, a.module.courseId);
  return a;
}

const staff = requireRole('instructor', 'admin');
const rawBody = (req, res, next) =>
  express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES })(req, res, (err) => {
    if (err?.type === 'entity.too.large') return next(new HttpError(413, `Fichier trop volumineux (${Math.round(MAX_UPLOAD_BYTES / 1048576)} Mo au maximum)`));
    next(err);
  });

router.put('/studio/assignments/:id/subject', staff, limiter, wrap(async (req, _res, next) => {
  req.assignment = await loadOwned(req.user, req.params.id); // droits vérifiés avant de lire le corps
  next();
}), rawBody, wrap(async (req, res) => {
  const check = checkUpload({ buffer: req.body, fileName: req.get('x-file-name') });
  if (!check.ok) throw new HttpError(check.status, check.message);
  const key = await saveBytes(req.body);
  try {
    await prisma.assessment.update({
      where: { id: req.assignment.id },
      data: { attachmentKey: key, attachmentMime: check.mime, attachmentSize: req.body.length, attachmentName: check.name, attachmentUrl: null },
    });
  } catch (e) {
    await removeBytes(key).catch(() => {});
    throw e;
  }
  if (req.assignment.attachmentKey) await removeBytes(req.assignment.attachmentKey).catch(() => {});
  res.status(201).json({ name: check.name, size: req.body.length, mime: check.mime });
}));

router.delete('/studio/assignments/:id/subject', staff, wrap(async (req, res) => {
  const a = await loadOwned(req.user, req.params.id);
  if (a.attachmentKey) {
    await prisma.assessment.update({
      where: { id: a.id },
      data: { attachmentKey: null, attachmentMime: null, attachmentSize: null, attachmentName: null },
    });
    await removeBytes(a.attachmentKey).catch(() => {});
  }
  res.status(204).end();
}));

router.get('/assignments/:id/subject', wrap(async (req, res) => {
  const { role } = req.user;
  const a = (role === 'instructor' || role === 'admin')
    ? await loadOwned(req.user, req.params.id)
    : (await accessAssignment(req.user, req.params.id)).assessment;
  // 404 partout : on ne révèle pas s'il existe un fichier à qui n'y a pas droit
  if (!a.attachmentKey) throw new HttpError(404, 'Aucun fichier pour ce devoir');
  if (!(await exists(a.attachmentKey))) throw new HttpError(410, 'Ce fichier n\'est plus disponible');
  res.set({
    'Content-Type': a.attachmentMime,
    'Content-Length': String(a.attachmentSize),
    'Content-Disposition': contentDisposition(a.attachmentName || 'sujet'),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
  const stream = openStream(a.attachmentKey);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}));

export default router;
