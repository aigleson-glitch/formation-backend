import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { wrap, HttpError } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { assertOwnsCourse } from "../lib/studioAccess.js";
import { chapterProfileSchema, UUID_RE } from "../lib/chapterProfile.js";

// Gestion du profil IA d'un chapitre par le formateur (ou l'administrateur)
const router = Router();
router.use(requireAuth, requireRole("instructor", "admin"));

async function loadChapter(req) {
  const chapter = await prisma.chapter.findUnique({ where: { id: req.params.id }, include: { module: true, aiProfile: true } });
  if (!chapter) throw new HttpError(404, "Chapitre introuvable");
  await assertOwnsCourse(req.user, chapter.module.courseId);
  return chapter;
}

router.get("/chapters/:id/ai-profile", wrap(async (req, res) => {
  const c = await loadChapter(req);
  res.json(c.aiProfile ? { profile: c.aiProfile.data, version: c.aiProfile.version, updatedAt: c.aiProfile.updatedAt } : { profile: null });
}));

router.put("/chapters/:id/ai-profile", validate(chapterProfileSchema), wrap(async (req, res) => {
  const chapter = await loadChapter(req);
  const { chapterId, ...profile } = req.body; // l'identifiant du chapitre vient de l'URL, pas du JSON

  const bad = profile.linkedLessonIds.filter((i) => !UUID_RE.test(i));
  if (bad.length) throw new HttpError(422, `linkedLessonIds : identifiant de leçon invalide (${bad[0]}). Remplacez les valeurs d'exemple ou laissez la liste vide.`);
  if (profile.linkedLessonIds.length) {
    const found = await prisma.lesson.count({ where: { id: { in: profile.linkedLessonIds }, chapter: { module: { courseId: chapter.module.courseId } } } });
    if (found !== new Set(profile.linkedLessonIds).size) throw new HttpError(422, "Une des leçons liées n'appartient pas à cette formation.");
  }

  const saved = chapter.aiProfile
    ? await prisma.chapterAiProfile.update({ where: { chapterId: chapter.id }, data: { data: profile, version: { increment: 1 } } })
    : await prisma.chapterAiProfile.create({ data: { chapterId: chapter.id, data: profile } });
  res.json({ ok: true, version: saved.version });
}));

router.delete("/chapters/:id/ai-profile", wrap(async (req, res) => {
  const chapter = await loadChapter(req);
  await prisma.chapterAiProfile.deleteMany({ where: { chapterId: chapter.id } });
  res.status(204).end();
}));

export default router;
