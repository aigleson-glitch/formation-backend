import { HttpError } from './http.js';

// Logique pure des quiz (aucun accès à la base) : validation, notation, résultat de module.
// Toute la notation se fait côté serveur ; le client ne reçoit jamais les bonnes réponses avant la soumission.

export const QUIZ_TYPES = ['quiz', 'mcq'];

/** Libellés des deux options d'une question vrai/faux (position 1 = vrai, position 2 = faux). */
export function buildTrueFalseOptions(correctAnswer, language = 'fr') {
  const [yes, no] = language === 'en' ? ['True', 'False'] : ['Vrai', 'Faux'];
  return [
    { text: yes, isCorrect: correctAnswer === true },
    { text: no, isCorrect: correctAnswer === false },
  ];
}

/**
 * Vérifie la définition d'une question (options fournies par le formateur).
 * Renvoie un message d'erreur, ou null si tout est correct.
 */
export function checkOptions(type, options) {
  if (!Array.isArray(options)) return 'Les options sont obligatoires';
  const correct = options.filter((o) => o.isCorrect).length;
  const texts = options.map((o) => o.text.trim().toLowerCase());
  if (new Set(texts).size !== texts.length) return 'Deux options ont le même texte';
  if (type === 'true_false') {
    if (options.length !== 2 || correct !== 1) return 'Une question vrai/faux a deux options dont une seule est correcte';
    return null;
  }
  if (options.length < 2 || options.length > 8) return 'Une question a entre 2 et 8 options';
  if (type === 'single' && correct !== 1) return 'Une question à choix unique a exactement une bonne réponse';
  if (type === 'multiple' && correct < 1) return 'Une question à choix multiple a au moins une bonne réponse';
  return null;
}

/**
 * Note une question. `question.options` porte `id` et `isCorrect`.
 * Tout ou rien : pour un choix multiple, il faut cocher exactement les bonnes options.
 */
export function gradeQuestion(question, selectedIds) {
  const correct = new Set(question.options.filter((o) => o.isCorrect).map((o) => o.id));
  const chosen = new Set(selectedIds);
  const ok = chosen.size > 0 && chosen.size === correct.size && [...chosen].every((id) => correct.has(id));
  return { isCorrect: ok, points: ok ? question.points : 0 };
}

/**
 * Contrôle et normalise les réponses envoyées par l'élève.
 * Renvoie une Map questionId → identifiants d'options (sans doublons).
 * Une question sans réponse est permise (elle compte pour 0).
 */
export function parseAnswers(questions, rawAnswers) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const out = new Map();
  for (const a of rawAnswers) {
    const q = byId.get(a.questionId);
    if (!q) throw new HttpError(400, 'Réponse à une question qui ne fait pas partie de ce quiz');
    if (out.has(a.questionId)) throw new HttpError(400, 'Une question est répondue deux fois');
    const ids = [...new Set(a.optionIds)];
    const valid = new Set(q.options.map((o) => o.id));
    if (!ids.every((id) => valid.has(id))) throw new HttpError(400, 'Option inconnue pour une des questions');
    if (q.type !== 'multiple' && ids.length > 1) throw new HttpError(400, 'Une seule réponse est permise pour cette question');
    out.set(a.questionId, ids);
  }
  return out;
}

/** Note une tentative entière. Renvoie le détail par question et le pourcentage (2 décimales). */
export function gradeAttempt(questions, answersByQuestion) {
  let earned = 0;
  let total = 0;
  const details = questions.map((q) => {
    const selected = answersByQuestion.get(q.id) ?? [];
    const g = gradeQuestion(q, selected);
    total += q.points;
    earned += g.points;
    return { questionId: q.id, selected, isCorrect: g.isCorrect, points: g.points };
  });
  const scorePct = total === 0 ? 0 : Math.round((earned / total) * 10000) / 100;
  return { details, earned, total, scorePct };
}

/** Règle 5 : un module est « compétent » quand toutes ses évaluations obligatoires sont réussies. */
export function moduleOutcome(requiredIds, passedIds, bestScoreById) {
  const allPassed = requiredIds.length > 0 && requiredIds.every((id) => passedIds.has(id));
  const scores = requiredIds.map((id) => bestScoreById.get(id)).filter((s) => s !== undefined);
  const scorePct = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null;
  return { status: allPassed ? 'competent' : 'not_yet', scorePct };
}

/** Temps écoulé ? On laisse 60 s de marge pour la latence du réseau. */
export const GRACE_MS = 60 * 1000;
export function isExpired(startedAt, timeLimitMin, now = Date.now()) {
  if (!timeLimitMin) return false;
  return now > new Date(startedAt).getTime() + timeLimitMin * 60 * 1000 + GRACE_MS;
}
export function deadlineOf(startedAt, timeLimitMin) {
  return timeLimitMin ? new Date(new Date(startedAt).getTime() + timeLimitMin * 60 * 1000) : null;
}
