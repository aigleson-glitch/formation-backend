import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { prisma } from "../lib/prisma.js";
import { wrap, HttpError } from "../lib/http.js";
import { hashPassword, checkPassword, signToken, publicUser, syncAgeGroup } from "../lib/auth.js";
import { computeAge, ageGroupFromBirthDate } from "../lib/ageGroup.js";
import { validate } from "../middleware/validate.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// Limitation des tentatives de connexion (exigence sécurité)
// Seules les tentatives échouées comptent : une classe derrière la même IP ne se bloque pas en se connectant normalement.
const tooMany = { error: "Trop de tentatives. Réessayez dans quelques minutes." };
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: tooMany });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: tooMany });

const registerSchema = z.object({
  accountType: z.enum(["adult", "teen", "parent"]),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
  birthDate: z.coerce.date(),
  parentEmail: z.string().trim().toLowerCase().email().optional(), // obligatoire pour un adolescent
  relationship: z.enum(["mother", "father", "guardian", "other"]).optional(),
});

// Parcours « Je suis adulte » / « Je suis adolescent » / parent (le parcours « J’inscris mon enfant » est dans /parent/children)
router.post("/register", registerLimiter, validate(registerSchema), wrap(async (req, res) => {
  const d = req.body;
  const age = computeAge(d.birthDate);
  const group = ageGroupFromBirthDate(d.birthDate);

  if (d.accountType === "teen") {
    if (group !== "teen") throw new HttpError(422, "Le parcours adolescent est réservé aux 13-17 ans");
    if (!d.parentEmail) throw new HttpError(422, "L’e-mail d’un parent ou tuteur est obligatoire");
  } else if (age < 18) {
    throw new HttpError(422, "Ce parcours est réservé aux adultes");
  }

  const exists = await prisma.user.findUnique({ where: { email: d.email } });
  if (exists) throw new HttpError(409, "Cet e-mail est déjà utilisé");

  let parent = null;
  if (d.accountType === "teen") {
    parent = await prisma.user.findUnique({ where: { email: d.parentEmail } });
    if (!parent || parent.role !== "parent") {
      throw new HttpError(422, "Aucun compte parent avec cet e-mail : le parent doit d’abord créer son compte parent");
    }
  }

  const user = await prisma.user.create({
    data: {
      email: d.email,
      passwordHash: await hashPassword(d.password),
      firstName: d.firstName, lastName: d.lastName, phone: d.phone,
      birthDate: d.birthDate, ageGroup: group,
      role: d.accountType === "parent" ? "parent" : "learner",
      // règle 11 : un compte ado n est actif qu après consentement parental
      isActive: d.accountType !== "teen",
    },
  });

  if (parent) {
    await prisma.guardianship.create({
      data: { parentId: parent.id, childId: user.id, relationship: d.relationship ?? "guardian", status: "pending" },
    });
    return res.status(201).json({
      user: publicUser(user),
      message: "Compte créé. Il sera activé quand votre parent aura donné son consentement.",
    });
  }
  res.status(201).json({ user: publicUser(user), token: signToken(user) });
}));

const loginSchema = z.object({
  identifier: z.string().min(1), // e-mail ou identifiant (enfants)
  password: z.string().min(1),
});

router.post("/login", loginLimiter, validate(loginSchema), wrap(async (req, res) => {
  const { identifier, password } = req.body;
  const user = await prisma.user.findFirst({
    where: identifier.trim().includes("@") ? { email: identifier.trim().toLowerCase() } : { username: identifier.trim().toLowerCase() },
  });
  if (!user || !(await checkPassword(password, user.passwordHash))) {
    throw new HttpError(401, "Identifiants incorrects");
  }
  if (!user.isActive) {
    throw new HttpError(403, "Compte inactif : en attente du consentement d’un parent, ou suspendu");
  }
  const fresh = await syncAgeGroup(user);
  res.json({ user: publicUser(fresh), token: signToken(fresh) });
}));

router.get("/me", requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

export default router;
