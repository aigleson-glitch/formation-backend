import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma.js";
import { ageGroupFromBirthDate } from "./ageGroup.js";

export const hashPassword = (p) => bcrypt.hash(p, 12);
export const checkPassword = (p, h) => bcrypt.compare(p, h);

// Le jeton est épinglé sur HS256 : un jeton signé autrement (par exemple « none ») est refusé.
export const verifyToken = (token) => jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });

// Compare toujours un hachage, même si le compte n'existe pas : le temps de réponse ne révèle pas si l'e-mail est inscrit.
let dummyHash;
export async function verifyLogin(user, password) {
  dummyHash ??= await bcrypt.hash("mot-de-passe-factice", 12);
  const ok = await bcrypt.compare(password, user ? user.passwordHash : dummyHash);
  return Boolean(user) && ok;
}

export const signToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

// Recalcule le groupe d’âge ; passage auto en adulte à 18 ans (règle 14).
// Au passage à l’âge adulte, la tutelle parentale prend fin : le parent ne voit plus rien de ce compte.
export async function syncAgeGroup(user) {
  if (!user.birthDate) return user;
  const current = ageGroupFromBirthDate(user.birthDate);
  if (current && current !== user.ageGroup) {
    const becameAdult = current === "adult" && user.ageGroup && user.ageGroup !== "adult";
    const [updated] = await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { ageGroup: current } }),
      ...(becameAdult
        ? [prisma.guardianship.updateMany({ where: { childId: user.id, status: "active" }, data: { status: "revoked", revokedAt: new Date() } })]
        : []),
    ]);
    return updated;
  }
  return user;
}

export const publicUser = (u) => ({
  id: u.id, email: u.email, username: u.username, firstName: u.firstName, lastName: u.lastName,
  role: u.role, ageGroup: u.ageGroup, locale: u.locale, canTeachMinors: u.canTeachMinors,
});
