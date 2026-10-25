import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { wrap, HttpError } from '../lib/http.js';
import { requireAuth, requireRole, isActiveGuardian } from '../middleware/auth.js';
import { ensureCertificates, certificateView } from '../lib/certificate.js';

// Le parent consulte, en lecture seule, les certificats de son enfant (règles 11 et 13).
const router = Router();
router.use(requireAuth, requireRole('parent'));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/children/:childId/certificates', wrap(async (req, res) => {
  if (!UUID.test(req.params.childId) || !(await isActiveGuardian(req.user.id, req.params.childId))) throw new HttpError(403, 'Accès refusé');
  await ensureCertificates(req.params.childId);
  const certs = await prisma.certificate.findMany({
    where: { enrollment: { userId: req.params.childId } },
    include: { enrollment: { include: { user: true, course: { select: { id: true, title: true, slug: true } } } } },
    orderBy: { issuedAt: 'desc' },
  });
  res.json(certs.map((c) => certificateView(c, c.enrollment, c.enrollment.user, c.enrollment.course)));
}));

export default router;
