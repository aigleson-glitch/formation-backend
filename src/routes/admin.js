import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { wrap, HttpError } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { hashPassword } from "../lib/auth.js";
import { UUID_RE } from "../lib/chapterProfile.js";

/**
 * Administration des comptes (administrateur uniquement).
 * - créer des formateurs et d'autres administrateurs ;
 * - donner ou retirer l'habilitation « mineurs » (règle 15) ;
 * - désactiver / réactiver un compte formateur ou administrateur.
 * Les comptes apprenants et parents ne se modifient pas ici : un adolescent en attente de consentement
 * ne doit jamais pouvoir être activé sans son parent (règle 11).
 */
const router = Router();
router.use(requireAuth, requireRole("admin"));

const STAFF_ROLES = ["instructor", "admin"];

const adminView = (u) => ({
  id: u.id, email: u.email, username: u.username, firstName: u.firstName, lastName: u.lastName,
  phone: u.phone, role: u.role, ageGroup: u.ageGroup, canTeachMinors: u.canTeachMinors,
  isActive: u.isActive, createdAt: u.createdAt,
});

const listQuery = z.object({
  role: z.enum(["learner", "parent", "instructor", "admin"]).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

router.get("/users", wrap(async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) throw new HttpError(400, "Paramètres invalides");
  const { role, q, page, pageSize } = parsed.data;
  const where = {
    ...(role && { role }),
    ...(q && {
      OR: ["email", "username", "firstName", "lastName"].map((f) => ({ [f]: { contains: q, mode: "insensitive" } })),
    }),
  };
  const [total, items] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  res.json({ total, page, pageSize, items: items.map(adminView) });
}));

const staffSchema = z.object({
  role: z.enum(STAFF_ROLES),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(10, "10 caractères au moins").max(72),
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  phone: z.string().trim().optional(),
  canTeachMinors: z.boolean().default(false),
});

router.post("/users", validate(staffSchema), wrap(async (req, res) => {
  const d = req.body;
  if (await prisma.user.findUnique({ where: { email: d.email } })) throw new HttpError(409, "Cet e-mail est déjà utilisé");
  const user = await prisma.user.create({
    data: {
      email: d.email, passwordHash: await hashPassword(d.password),
      firstName: d.firstName, lastName: d.lastName, phone: d.phone,
      role: d.role,
      canTeachMinors: d.role === "instructor" && d.canTeachMinors, // l'habilitation ne concerne que les formateurs
      isActive: true,
    },
  });
  res.status(201).json(adminView(user));
}));

const patchSchema = z.object({
  firstName: z.string().trim().min(1).optional(),
  lastName: z.string().trim().min(1).optional(),
  canTeachMinors: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

// Formations publiées pour mineurs dont ce formateur est le dernier formateur habilité et actif
async function minorCoursesLosingTeacher(userId) {
  const courses = await prisma.course.findMany({
    where: {
      isPublished: true,
      instructors: { some: { userId } },
      audiences: { some: { ageGroup: { in: ["child", "teen"] } } },
    },
    select: { id: true, title: true, instructors: { select: { userId: true, user: { select: { canTeachMinors: true, isActive: true } } } } },
  });
  return courses
    .filter((c) => !c.instructors.some((i) => i.userId !== userId && i.user.canTeachMinors && i.user.isActive))
    .map((c) => ({ id: c.id, title: c.title }));
}

router.patch("/users/:id", validate(patchSchema), wrap(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) throw new HttpError(404, "Compte introuvable");
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target || !STAFF_ROLES.includes(target.role)) throw new HttpError(404, "Compte formateur ou administrateur introuvable");
  const b = req.body;

  if (target.id === req.user.id && b.isActive === false) throw new HttpError(409, "Vous ne pouvez pas désactiver votre propre compte");
  if (b.canTeachMinors !== undefined && target.role !== "instructor") throw new HttpError(422, "L'habilitation « mineurs » ne concerne que les formateurs");

  if (b.canTeachMinors === false && target.canTeachMinors) {
    const blocking = await minorCoursesLosingTeacher(target.id);
    if (blocking.length) {
      const titles = blocking.slice(0, 5).map((c) => `« ${c.title} »`).join(", ");
      throw new HttpError(409, `Retrait impossible : ces formations pour mineurs n'auraient plus de formateur habilité (${titles}). Affectez d'abord un autre formateur habilité.`);
    }
  }

  const updated = await prisma.user.update({ where: { id: target.id }, data: b });
  const out = adminView(updated);
  // Désactiver n'est jamais bloqué (mesure de sécurité) : on signale seulement ce qui reste sans formateur.
  if (b.isActive === false && target.isActive) out.minorCoursesWithoutTeacher = await minorCoursesLosingTeacher(target.id);
  res.json(out);
}));

export default router;
