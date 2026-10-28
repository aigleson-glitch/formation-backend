import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { wrap, HttpError } from '../lib/http.js';
import { requireAuth, requireRole, isActiveGuardian } from '../middleware/auth.js';
import { fileView } from '../lib/uploadRules.js';

// Le parent consulte, en lecture seule, les devoirs rendus par son enfant et leur correction (règles 11 et 13).
const router = Router();
router.use(requireAuth, requireRole('parent'));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/children/:childId/submissions', wrap(async (req, res) => {
  if (!UUID.test(req.params.childId) || !(await isActiveGuardian(req.user.id, req.params.childId))) throw new HttpError(403, 'Accès refusé');
  const rows = await prisma.submission.findMany({
    where: { enrollment: { userId: req.params.childId } },
    orderBy: { submittedAt: 'desc' },
    take: 100,
    select: {
      id: true, attemptNo: true, status: true, submittedAt: true, content: true, linkUrl: true,
      scorePct: true, passed: true, feedback: true, gradedAt: true,
      file: { select: { id: true, originalName: true, mimeType: true, sizeBytes: true } },
      assessment: { select: { title: true, module: { select: { title: true, course: { select: { id: true, title: true } } } } } },
    },
  });
  res.json(rows.map((s) => {
    const corrected = s.status === 'graded' || s.status === 'resubmit';
    return {
      id: s.id, attemptNo: s.attemptNo, status: s.status, submittedAt: s.submittedAt, content: s.content, linkUrl: s.linkUrl, file: fileView(s.file),
      assignment: s.assessment.title, module: s.assessment.module.title, course: s.assessment.module.course,
      ...(corrected && { scorePct: s.scorePct === null ? null : Number(s.scorePct), passed: s.passed, feedback: s.feedback, gradedAt: s.gradedAt }),
    };
  }));
}));

export default router;
