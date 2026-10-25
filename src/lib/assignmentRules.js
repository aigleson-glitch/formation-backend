// Règles des devoirs (phase 3), sans accès à la base : testables seules.

export const ASSIGNMENT_TYPES = ['assignment', 'portfolio'];
export const OPEN_STATUSES = ['submitted', 'in_review']; // en attente de correction
export const MAX_CONTENT = 20000;
export const MAX_LINK = 2000;

/** Un devoir contient un texte, un lien, ou les deux. Le lien doit être en https. */
export function contentProblem({ content, linkUrl } = {}) {
  const text = (content ?? '').trim();
  const link = (linkUrl ?? '').trim();
  if (!text && !link) return 'Ajoutez un texte ou un lien';
  if (text.length > MAX_CONTENT) return `Le texte ne peut pas dépasser ${MAX_CONTENT} caractères`;
  if (link) {
    if (link.length > MAX_LINK) return 'Le lien est trop long';
    let url;
    try { url = new URL(link); } catch { return 'Le lien n\'est pas valide'; }
    if (url.protocol !== 'https:') return 'Le lien doit commencer par https://';
  }
  return null;
}

/**
 * L'élève peut-il rendre un nouveau devoir ?
 * - déjà réussi : non ; une copie attend sa correction : non ;
 * - les tentatives s'épuisent avec les copies corrigées. Une copie renvoyée « à resoumettre » par le formateur
 *   ne consomme pas de tentative : c'est lui qui la redemande.
 */
export function submitDecision({ maxAttempts, submissions }) {
  if (submissions.some((s) => s.passed === true)) return { ok: false, status: 409, message: 'Ce devoir est déjà réussi' };
  if (submissions.some((s) => OPEN_STATUSES.includes(s.status))) {
    return { ok: false, status: 409, message: 'Votre devoir est en attente de correction' };
  }
  const used = submissions.filter((s) => s.status !== 'resubmit').length;
  if (used >= maxAttempts) return { ok: false, status: 403, message: 'Toutes les tentatives sont utilisées' };
  return { ok: true, attemptsLeft: maxAttempts - used };
}

/** Validation d'une correction : « graded » exige une note, les deux décisions exigent un commentaire. */
export function gradeProblem({ decision, scorePct, feedback }) {
  if (!['graded', 'resubmit'].includes(decision)) return 'Décision inconnue';
  if (!(feedback ?? '').trim()) return 'Un commentaire est obligatoire';
  if (decision === 'graded') {
    if (typeof scorePct !== 'number' || !Number.isFinite(scorePct) || scorePct < 0 || scorePct > 100) {
      return 'La note doit être un pourcentage entre 0 et 100';
    }
  }
  return null;
}

/**
 * Sujet joint à un devoir (PDF à télécharger) : un lien https, avec un nom d'affichage facultatif.
 * Le nom sans lien n'a pas de sens ; un lien non https (http, javascript:, data:) est refusé.
 */
export function attachmentProblem({ attachmentUrl, attachmentName } = {}) {
  const url = (attachmentUrl ?? '').trim();
  const name = (attachmentName ?? '').trim();
  if (!url) return name ? 'Un nom de fichier exige un lien' : null;
  if (url.length > MAX_LINK) return 'Le lien du fichier est trop long';
  let parsed;
  try { parsed = new URL(url); } catch { return 'Le lien du fichier n\'est pas valide'; }
  if (parsed.protocol !== 'https:') return 'Le lien du fichier doit commencer par https://';
  if (name.length > 200) return 'Le nom du fichier est trop long (200 caractères au maximum)';
  return null;
}

export const isPassed = (scorePct, passMark) => scorePct >= passMark;

/** Une correction peut être modifiée tant qu'aucune copie plus récente n'existe. */
export function canRegrade(submission, latestAttemptNo) {
  return submission.status === 'graded' && submission.attemptNo === latestAttemptNo;
}
