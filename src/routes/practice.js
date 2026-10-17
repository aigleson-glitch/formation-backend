import { Router } from "express";
import express from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { prisma } from "../lib/prisma.js";
import { wrap, HttpError } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { ai, isUnintelligible } from "../lib/ai.js";
import { chapterProfileSchema, focusSchema, UUID_RE } from "../lib/chapterProfile.js";
import { askQuestion, giveFeedback, buildLessonExcerpts, feedbackLanguageFor } from "../lib/tutor.js";

/**
 * ESPACE ENTRAÎNEMENT (bienveillant) : aucune note, aucun chronomètre, l'audio n'est jamais conservé.
 * Séparé de l'examen : ce fichier ne lit que le profil du chapitre et le texte des leçons.
 */
const router = Router();
router.use(requireAuth, requireRole("learner"));

const SESSION_HOURS = 24;
const byUser = (limit, message) =>
  rateLimit({ windowMs: 60 * 60 * 1000, limit, keyGenerator: (req) => req.user.id, standardHeaders: true, legacyHeaders: false, message: { error: message } });
const startLimiter = byUser(20, "Vous avez déjà fait beaucoup d'exercices. Faites une pause et revenez dans un moment !");
const nextLimiter = byUser(40, "Vous avez déjà fait beaucoup d'exercices. Faites une pause et revenez dans un moment !");
const answerLimiter = byUser(40, "Vous avez déjà fait beaucoup d'exercices. Faites une pause et revenez dans un moment !");

const publicQuestion = (q) => q && ({
  question: q.question, situation: q.situation, hint: q.hint, hintTranslation: q.hintTranslation,
  targetKeywordIds: q.targetKeywordIds, targetGrammarIds: q.targetGrammarIds,
});

function parseProfile(chapter) {
  const r = chapterProfileSchema.safeParse(chapter.aiProfile?.data);
  if (!r.success) throw new HttpError(422, "Ce chapitre n'est pas encore prêt pour l'entraînement oral.");
  return r.data;
}

async function assertEnrolled(userId, courseId) {
  const e = await prisma.enrollment.findUnique({ where: { userId_courseId: { userId, courseId } } });
  if (!e || e.status === "cancelled") throw new HttpError(403, "Vous n'êtes pas inscrit à cette formation.");
  if (e.status === "pending") throw new HttpError(402, "Paiement requis pour accéder à cette formation.");
}

// Texte de référence pour le tuteur : leçons liées au profil, sinon leçons du chapitre lui-même
async function loadExcerpts(chapter, profile) {
  const ids = profile.linkedLessonIds.filter((i) => UUID_RE.test(i));
  const lessons = await prisma.lesson.findMany({
    where: ids.length ? { id: { in: ids }, chapter: { module: { courseId: chapter.module.courseId } } } : { chapterId: chapter.id },
    orderBy: { position: "asc" },
    select: { title: true, content: true },
  });
  return buildLessonExcerpts(lessons);
}

const chapterInclude = { aiProfile: true, module: { select: { courseId: true } } };

async function buildContext(user, chapter, focus) {
  const profile = parseProfile(chapter);
  return {
    profile, focus,
    ageGroup: user.ageGroup,
    feedbackLanguage: feedbackLanguageFor(profile, user.ageGroup),
    lessonExcerpts: await loadExcerpts(chapter, profile),
  };
}

async function ownedSession(id, userId) {
  if (!UUID_RE.test(id)) throw new HttpError(404, "Séance introuvable.");
  const s = await prisma.practiceSession.findFirst({ where: { id, userId }, include: { chapter: { include: chapterInclude } } });
  if (!s) throw new HttpError(404, "Séance introuvable.");
  if (s.expiresAt < new Date()) throw new HttpError(410, "Cette séance est terminée. Commencez-en une nouvelle.");
  return s;
}

// Chapitres où l'étudiant peut s'entraîner (inscription active, profil présent)
router.get("/chapters", wrap(async (req, res) => {
  const enrollments = await prisma.enrollment.findMany({
    where: { userId: req.user.id, status: { in: ["active", "completed"] } },
    select: {
      course: {
        select: {
          id: true, title: true,
          modules: {
            orderBy: { position: "asc" },
            select: {
              chapters: {
                where: { aiProfile: { isNot: null } },
                orderBy: { position: "asc" },
                select: { id: true, title: true, aiProfile: { select: { data: true } } },
              },
            },
          },
        },
      },
    },
  });
  const out = [];
  for (const { course } of enrollments) {
    const chapters = [];
    for (const m of course.modules) {
      for (const c of m.chapters) {
        const p = chapterProfileSchema.safeParse(c.aiProfile.data);
        if (!p.success) continue;
        chapters.push({ id: c.id, title: c.title, level: p.data.level, grammar: p.data.grammar.map((g) => ({ id: g.id, title: g.title })), keywordCount: p.data.keywords.length });
      }
    }
    if (chapters.length) out.push({ courseId: course.id, courseTitle: course.title, chapters });
  }
  res.json(out);
}));

const startSchema = z.object({ chapterId: z.string().uuid(), focus: focusSchema.optional() });

router.post("/start", startLimiter, validate(startSchema), wrap(async (req, res) => {
  const focus = req.body.focus ?? { type: "all" };
  const chapter = await prisma.chapter.findUnique({ where: { id: req.body.chapterId }, include: chapterInclude });
  if (!chapter || !chapter.aiProfile) throw new HttpError(404, "Ce chapitre n'a pas d'entraînement oral.");
  await assertEnrolled(req.user.id, chapter.module.courseId);

  const ctx = await buildContext(req.user, chapter, focus);
  if (focus.type === "grammar" && !ctx.profile.grammar.some((g) => g.id === focus.grammarId)) {
    throw new HttpError(400, "Point de grammaire inconnu pour ce chapitre.");
  }
  const question = await askQuestion(ctx, []);
  const session = await prisma.practiceSession.create({
    data: { userId: req.user.id, chapterId: chapter.id, focus, currentQuestion: question, expiresAt: new Date(Date.now() + SESSION_HOURS * 3600_000) },
  });
  res.status(201).json({ practiceId: session.id, chapterTitle: chapter.title, question: publicQuestion(question) });
}));

// Réponse orale : l'audio arrive tel quel dans le corps de la requête (Content-Type: audio/*)
router.post("/:id/answer", answerLimiter, express.raw({ type: ["audio/*", "video/webm"], limit: "5mb" }), wrap(async (req, res) => {
  const session = await ownedSession(req.params.id, req.user.id);
  if (!session.currentQuestion) throw new HttpError(409, "Aucune question en attente. Demandez une nouvelle question.");
  if (!Buffer.isBuffer(req.body) || req.body.length < 2000) throw new HttpError(400, "Enregistrement vide ou trop court. Réessayez.");

  const ctx = await buildContext(req.user, session.chapter, session.focus ?? { type: "all" });
  const asr = await ai.transcribe({
    buffer: req.body,
    mimeType: (req.headers["content-type"] || "").split(";")[0],
    hintTerms: ctx.profile.keywords.map((k) => k.term),
  }); // l'audio n'est pas écrit sur le disque ni en base : il disparaît après cet appel

  if (isUnintelligible(asr)) {
    return res.json({ understood: false, transcript: asr.text, message: "Je n'ai pas bien entendu. Parlez un peu plus fort, près du micro, et réessayons !" });
  }

  const feedback = await giveFeedback(ctx, session.currentQuestion, asr.text);
  const turns = [...(Array.isArray(session.turns) ? session.turns : []), { question: session.currentQuestion.question, transcript: asr.text, feedback }].slice(-20);
  await prisma.practiceSession.update({ where: { id: session.id }, data: { turns } });
  res.json({ understood: true, transcript: asr.text, feedback });
}));

// Question suivante (ou nouvelle question si l'étudiant passe)
router.post("/:id/next", nextLimiter, wrap(async (req, res) => {
  const session = await ownedSession(req.params.id, req.user.id);
  const ctx = await buildContext(req.user, session.chapter, session.focus ?? { type: "all" });
  const asked = [
    ...(Array.isArray(session.turns) ? session.turns.map((t) => t.question) : []),
    ...(session.currentQuestion ? [session.currentQuestion.question] : []),
  ];
  const question = await askQuestion(ctx, asked);
  await prisma.practiceSession.update({ where: { id: session.id }, data: { currentQuestion: question } });
  res.json({ question: publicQuestion(question) });
}));

export default router;
