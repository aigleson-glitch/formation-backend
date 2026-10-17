// Tranches proposées : 5-12 enfants, 13-17 ados, 18+ adultes (à valider, question ouverte n°6)
export const MIN_AGE = 5;

export function computeAge(birthDate, now = new Date()) {
  const b = new Date(birthDate);
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

export function ageGroupFromBirthDate(birthDate, now = new Date()) {
  const age = computeAge(birthDate, now);
  if (age < MIN_AGE) return null;
  if (age <= 12) return "child";
  if (age <= 17) return "teen";
  return "adult";
}
