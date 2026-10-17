import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma.js";
import { ageGroupFromBirthDate } from "./ageGroup.js";

export const hashPassword = (p) => bcrypt.hash(p, 12);
export const checkPassword = (p, h) => bcrypt.compare(p, h);

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
