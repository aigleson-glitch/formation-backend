import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { wrap, HttpError } from "../lib/http.js";
import { hashPassword, publicUser } from "../lib/auth.js";
import { ageGroupFromBirthDate } from "../lib/ageGroup.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, requireRole, isActiveGuardian } from "../middleware/auth.js";
import { courseProgress } from "../lib/progress.js";

const router = Router();
router.use(requireAuth, requireRole("parent"));

// Liste des enfants (actifs et en attente)
router.get("/children", wrap(async (req, res) => {
  const links = await prisma.guardianship.findMany({
    where: { parentId: req.user.id, status: { in: ["pending", "active"] } },
    include: { child: true },
  });
  res.json(links.map((g) => ({ guardianshipId: g.id, status: g.status, relationship: g.relationship, child: publicUser(g.child) })));
}));

const childSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  birthDate: z.coerce.date(),
  username: z.string().trim().min(3).regex(/^[a-z0-9_.-]+$/i, "Lettres, chiffres, _ . - uniquement").transform((s) => s.toLowerCase()),
  password: z.string().min(6), // mot de passe ou code PIN
  relationship: z.enum(["mother", "father", "guardian", "other"]).default("guardian"),
});

// Parcours « J’inscris mon enfant » : le parent crée et valide le compte (consentement donné à la création)
router.post("/children", validate(childSchema), wrap(async (req, res) => {
  const d = req.body;
  const group = ageGroupFromBirthDate(d.birthDate);
  if (!group || group === "adult") throw new HttpError(422, "L enfant doit avoir entre 5 et 17 ans");
  if (await prisma.user.findUnique({ where: { username: d.username } })) throw new HttpError(409, "Identifiant déjà pris");

  // Collecte minimale : prénom, date de naissance (+ nom exigé par le schéma), pas d’e-mail ni de téléphone
  const child = await prisma.$transaction(async (tx) => {
    const c = await tx.user.create({
      data: {
        username: d.username, passwordHash: await hashPassword(d.password),
        firstName: d.firstName, lastName: d.lastName, birthDate: d.birthDate, ageGroup: group,
        role: "learner", isActive: true,
      },
    });
    await tx.guardianship.create({
      data: { parentId: req.user.id, childId: c.id, relationship: d.relationship, status: "active", consentGivenAt: new Date() },
    });
    return c;
  });
  res.status(201).json({ child: publicUser(child) });
}));

// Consentement d’un parent pour un ado inscrit seul → active le compte
router.post("/guardianships/:id/consent", wrap(async (req, res) => {
  const g = await prisma.guardianship.findFirst({ where: { id: req.params.id, parentId: req.user.id } });
  if (!g || g.status !== "pending") throw new HttpError(404, "Demande de consentement introuvable");
  await prisma.$transaction([
    prisma.guardianship.update({ where: { id: g.id }, data: { status: "active", consentGivenAt: new Date() } }),
    prisma.user.update({ where: { id: g.childId }, data: { isActive: true } }),
  ]);
  res.json({ ok: true });
}));

// Retrait du consentement → suspend le compte si plus aucun parent actif (règle 11)
router.post("/guardianships/:id/revoke", wrap(async (req, res) => {
  const g = await prisma.guardianship.findFirst({ where: { id: req.params.id, parentId: req.user.id, status: "active" } });
  if (!g) throw new HttpError(404, "Lien introuvable");
  await prisma.guardianship.update({ where: { id: g.id }, data: { status: "revoked", revokedAt: new Date() } });
  const others = await prisma.guardianship.count({ where: { childId: g.childId, status: "active" } });
  if (others === 0) await prisma.user.update({ where: { id: g.childId }, data: { isActive: false } });
  res.json({ ok: true, childSuspended: others === 0 });
}));

// Suivi en lecture seule (règle 13)
router.get("/children/:childId/progress", wrap(async (req, res) => {
  if (!(await isActiveGuardian(req.user.id, req.params.childId))) throw new HttpError(403, "Accès refusé");
  const enrollments = await prisma.enrollment.findMany({
    where: { userId: req.params.childId },
    include: { course: { select: { id: true, title: true, slug: true } }, certificate: { select: { code: true, issuedAt: true } } },
  });
  const out = [];
  for (const e of enrollments) out.push({ enrollmentId: e.id, status: e.status, course: e.course, certificate: e.certificate, progressPct: await courseProgress(e.id, e.courseId) });
  res.json(out);
}));

export default router;
