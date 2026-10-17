import { z } from "zod";

export const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const id = z.string().min(1).max(60).regex(/^[a-z0-9][a-z0-9_-]*$/i, "Identifiant : lettres, chiffres, tirets ou tirets bas");
const text = (max = 500) => z.string().trim().min(1).max(max);
const optText = (max = 500) => z.string().trim().max(max).optional();

const keyword = z.object({
  id, term: text(80), partOfSpeech: optText(40), definition: text(300),
  translationTeaching: optText(120), example: optText(300),
});

const grammar = z.object({
  id, title: text(120), rule: text(800),
  forms: z.record(z.string().max(300)).default({}),
  examples: z.array(z.object({ correct: text(300), incorrect: optText(300), note: optText(300) })).max(10).default([]),
  commonMistakes: z.array(text(300)).max(10).default([]),
  frenchSpeakerTraps: z.array(text(300)).max(10).default([]),
});

const task = z.object({
  id, type: z.enum(["describe", "roleplay", "opinion", "retell"]), prompt: text(400),
  targetKeywordIds: z.array(z.string()).max(10).default([]),
  targetGrammarIds: z.array(z.string()).max(10).default([]),
  expectedDurationSec: z.number().int().min(10).max(120).default(30),
  difficulty: z.number().int().min(1).max(5).default(1),
});

export const chapterProfileSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  chapterId: z.string().optional(), // ignoré : l'identifiant vient de l'URL
  linkedLessonIds: z.array(z.string()).max(30).default([]),
  title: text(150),
  level: z.enum(LEVELS),
  targetLanguage: z.literal("en").default("en"),
  teachingLanguage: z.enum(["fr", "en"]).default("fr"),
  objectives: z.array(text(200)).max(10).default([]),
  keywords: z.array(keyword).min(1).max(80),
  grammar: z.array(grammar).max(30).default([]),
  irregularParticiples: z.array(z.object({ base: text(40), past: text(40), participle: text(60) })).max(100).default([]),
  functionalPhrases: z.array(text(200)).max(40).default([]),
  speakingTasks: z.array(task).min(1).max(30),
  scope: z.object({
    allowedTopics: z.array(text(80)).max(30).default([]),
    outOfScope: z.array(text(120)).max(30).default([]),
  }).default({}),
  tutorNotes: optText(1000),
}).superRefine((p, ctx) => {
  const dup = (arr, path, label) => {
    const seen = new Set();
    arr.forEach((x, i) => {
      if (seen.has(x.id)) ctx.addIssue({ code: "custom", path: [path, i, "id"], message: `Identifiant en double (${label}) : ${x.id}` });
      seen.add(x.id);
    });
  };
  dup(p.keywords, "keywords", "mot-clé");
  dup(p.grammar, "grammar", "règle");
  dup(p.speakingTasks, "speakingTasks", "tâche");

  const kw = new Set(p.keywords.map((k) => k.id));
  const gr = new Set(p.grammar.map((g) => g.id));
  p.speakingTasks.forEach((t, i) => {
    t.targetKeywordIds.forEach((k) => { if (!kw.has(k)) ctx.addIssue({ code: "custom", path: ["speakingTasks", i, "targetKeywordIds"], message: `Mot-clé inconnu : ${k}` }); });
    t.targetGrammarIds.forEach((g) => { if (!gr.has(g)) ctx.addIssue({ code: "custom", path: ["speakingTasks", i, "targetGrammarIds"], message: `Règle inconnue : ${g}` }); });
  });
  if (JSON.stringify(p).length > 60000) ctx.addIssue({ code: "custom", path: [], message: "Profil trop volumineux (60 Ko maximum)" });
});

export const focusSchema = z.object({
  type: z.enum(["all", "grammar", "vocabulary"]).default("all"),
  grammarId: z.string().optional(),
}).default({ type: "all" });

// Ce que l'étudiant a choisi de travailler, formulé pour le prompt
export function describeFocus(profile, focus) {
  if (focus?.type === "grammar") {
    const g = profile.grammar.find((x) => x.id === focus.grammarId);
    return g ? `Grammar: ${g.title}` : "Grammar (whole chapter)";
  }
  if (focus?.type === "vocabulary") return `Vocabulary: ${profile.keywords.map((k) => k.term).join(", ")}`;
  return "whole chapter";
}
