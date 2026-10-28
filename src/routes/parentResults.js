import { Router } from 'express';
import { wrap, HttpError } from '../lib/http.js';
import { requireAuth, requireRole, isActiveGuardian } from '../middleware/auth.js';
import { loadResults } from '../lib/resultsData.js';

// Le parent consulte, en lecture seule, les résultats de son enfant : statut par module, notes des quiz, état des devoirs.
const router = Router();
router.use(requireAuth, requireRole('parent'));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/children/:childId/results', wrap(async (req, res) => {
  if (!UUID.test(req.params.childId) || !(await isActiveGuardian(req.user.id, req.params.childId))) throw new HttpError(403, 'Accès refusé');
  res.json(await loadResults(req.params.childId));
}));

export default router;
