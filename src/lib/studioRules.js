// Règles du studio (formateurs, mineurs, ordre des éléments). Aucune dépendance à la base : testable seul.

export const MINOR_GROUPS = ['child', 'teen'];
export const hasMinors = (audiences) => audiences.some((a) => MINOR_GROUPS.includes(a));

/**
 * Règle 15 : une formation destinée à des mineurs n'a que des formateurs habilités ;
 * une fois publiée, elle en a au moins un. Les formateurs désactivés ne comptent pas.
 * `instructors` : liste de { canTeachMinors, isActive }. Renvoie un message d'erreur, ou null.
 */
export function minorsRuleProblem({ audiences, instructors, published = false }) {
  if (!hasMinors(audiences)) return null;
  const active = instructors.filter((i) => i.isActive !== false);
  if (active.some((i) => !i.canTeachMinors)) return "Un formateur affecté n'est pas habilité à enseigner à des mineurs";
  if (published && active.length === 0) return 'Une formation pour mineurs publiée doit avoir au moins un formateur habilité';
  return null;
}

/** Réordonnancement : la liste doit reprendre exactement les éléments actuels, une fois chacun. */
export function reorderProblem(ids, currentIds) {
  if (new Set(ids).size !== ids.length) return 'Un identifiant apparaît deux fois';
  const current = new Set(currentIds);
  if (ids.length !== current.size || !ids.every((id) => current.has(id))) {
    return 'La liste doit contenir exactement tous les éléments, une seule fois chacun';
  }
  return null;
}

/** Une leçon vidéo, audio ou PDF a besoin d'un lien média. */
export const mediaProblem = (type, mediaUrl) =>
  type !== 'text' && !mediaUrl ? 'Un média est requis pour ce type de leçon' : null;

/**
 * Une évaluation est « jouable » si ce n'est pas un quiz, ou si le quiz a au moins une question.
 * Même règle que le filtre PLAYABLE de progress.js (qui, lui, s'applique dans les requêtes).
 */
export const isPlayable = (type, questionCount) => !['quiz', 'mcq'].includes(type) || questionCount > 0;
