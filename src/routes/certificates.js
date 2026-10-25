import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { prisma } from '../lib/prisma.js';
import { wrap, HttpError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { ensureCertificates, normalizeCode, publicHolderName, certificateView } from '../lib/certificate.js';

// Certificats : consultation par l'élève et vérification publique par code.
// Monté avant les routes de quiz (qui exigent la connexion sur tout « / ») : la vérification, elle, est publique.
const router = Router();

const include = { enrollment: { include: { user: true, course: { select: { id: true, title: true, slug: true } } } } };

router.get('/my/certificates', requireAuth, wrap(async (req, res) => {
  await ensureCertificates(req.user.id);
  const certs = await prisma.certificate.findMany({ where: { enrollment: { userId: req.user.id } }, include, orderBy: { issuedAt: 'desc' } });
  res.json(certs.map((c) => certificateView(c, c.enrollment, c.enrollment.user, c.enrollment.course)));
}));

router.get('/my/certificates/:code', requireAuth, wrap(async (req, res) => {
  await ensureCertificates(req.user.id);
  const code = normalizeCode(req.params.code);
  const cert = code && await prisma.certificate.findUnique({ where: { code }, include });
  // Un certificat n'est visible que par son titulaire (404 sinon, pour ne rien révéler)
  if (!cert || cert.enrollment.userId !== req.user.id) throw new HttpError(404, 'Certificat introuvable');
  res.json(certificateView(cert, cert.enrollment, cert.enrollment.user, cert.enrollment.course));
}));

// Vérification publique : sans connexion, limitée pour empêcher de deviner des codes
const verifyLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Trop de vérifications. Réessayez dans une minute.' },
});

router.get('/certificates/verify/:code', verifyLimiter, wrap(async (req, res) => {
  const code = normalizeCode(req.params.code);
  const cert = code && await prisma.certificate.findUnique({ where: { code }, include });
  if (!cert) return res.status(404).json({ valid: false, error: 'Code inconnu' });
  const { user, course } = cert.enrollment;
  res.json({
    valid: true, code: cert.code, issuedAt: cert.issuedAt,
    holder: publicHolderName(user), course: course.title,
    issuer: process.env.CERTIFICATE_ISSUER_NAME || 'Plateforme de formation',
  });
}));

export default router;
