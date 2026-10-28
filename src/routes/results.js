import { Router } from 'express';
import { wrap } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { loadResults } from '../lib/resultsData.js';

// « Mes résultats » : statut Compétent / Pas encore compétent par module, notes et état de chaque quiz et devoir.
// La connexion est exigée route par route (et non sur tout « / ») pour ne pas bloquer les routes publiques montées après.
const router = Router();

router.get('/my/results', requireAuth, wrap(async (req, res) => {
  res.json(await loadResults(req.user.id));
}));

export default router;
