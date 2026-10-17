/**
 * Logique du tuteur (espace entraînement). Aucune dépendance à la base : testable seul.
 * - construit le prompt à partir du profil du chapitre
 * - traite la parole de l'étudiant comme une DONNÉE (balises neutralisées)
 * - valide strictement les sorties JSON, relance une fois, ne renvoie jamais le texte brut
 * - refuse toute réponse qui contiendrait une note (le prompt l'interdit, ceci le garantit)
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ai } from "./ai.js";
import { HttpError } from "./http.js";
import { describeFocus } from "./chapterProfile.js";

const TEMPLATE = readFileSync(new URL("../prompts/tutor.system.txt", import.meta.url), "utf8");

const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : ""));

/** Retire les chevrons : l'étudiant ne peut pas fermer lui-même une balise du prompt. */
export const cleanStudentText = (s, max = 1500) =>
  String(s ?? "").replace(/[<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Texte des leçons limité à ~3 000 mots (16 000 caractères), balises neutralisées. */
export function buildLessonExcerpts(lessons, maxChars = 16000) {
  const parts = [];
  let used = 0;
  for (const l of lessons) {
    const body = String(l.content ?? "").replace(/[<>]/g, " ").trim();
    if (!body) continue;
    const room = maxChars - used;
    if (room < 200) break;
    const chunk = `## ${String(l.title).replace(/[<>]/g, " ")}\n${body.slice(0, room)}`;
    parts.push(chunk);
    used += chunk.length;
  }
  return parts.join("\n\n") || "(no lesson text available)";
}

export function buildSystemPrompt({ profile, ageGroup, feedbackLanguage, lessonExcerpts, focus }) {
  const { chapterId, linkedLessonIds, ...forPrompt } = profile; // identifiants internes inutiles pour l'IA
  return fill(TEMPLATE, {
    age_group: ageGroup || "adult",
    level: profile.level,
    feedback_language: feedbackLanguage,
    chapter_profile_json: JSON.stringify(forPrompt).replace(/</g, "\\u003c").replace(/>/g, "\\u003e"),
    lesson_excerpts_text: lessonExcerpts,
    focus_description: describeFocus(profile, focus),
  });
}

/** Retours en français pour les enfants et les niveaux A1-A2, en anglais au-delà. */
export const feedbackLanguageFor = (profile, ageGroup) =>
  ageGroup === "child" || ["A1", "A2"].includes(profile.level) ? profile.teachingLanguage : "en";

// ── Sorties attendues ───────────────────────────────────
const str = (max) => z.string().max(max).default("");

export const askSchema = z.object({
  question: z.string().min(5).max(400),
  situation: str(300),
  targetKeywordIds: z.array(z.string()).max(10).default([]),
  targetGrammarIds: z.array(z.string()).max(10).default([]),
  hint: str(300),
  hintTranslation: str(300),
});

export const feedbackSchema = z.object({
  encouragement: z.string().min(1).max(500),
  improvements: z.array(z.object({ said: z.string().max(300), better: z.string().max(300), why: z.string().max(300) })).max(2).default([]),
  modelAnswer: str(600),
  tip: str(300),
  nextStep: str(300),
  retryRecommended: z.boolean().default(false),
  followUpQuestion: str(300),
});

const SCORE_PATTERNS = [
  /\b\d+(?:[.,]\d+)?\s*\/\s*(?:10|20|100)\b/, // 15/20
  /\b\d{1,3}\s*%/,                             // 80 %
  /\bsur\s+(?:10|20)\b/i,                      // sur 20
  /\b(?:score|grade)\b/i,
  /\byour marks?\b/i,
  /\b(?:ta|votre|ma|la|une)\s+note\b/i,
  /[★⭐]/u,
];
export const containsScore = (obj) => {
  const s = JSON.stringify(obj);
  return SCORE_PATTERNS.some((re) => re.test(s));
};

export function extractJson(raw) {
  const cleaned = String(raw).replace(/```(?:json)?/gi, "");
  const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no json");
  return JSON.parse(cleaned.slice(a, b + 1));
}

async function runTask({ system, user, schema, temperature, normalize = (x) => x, check = () => null }) {
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const message = attempt === 0
      ? user
      : `${user}\n\n<reminder>Your previous reply was not valid (${problem}). Reply again with ONLY the JSON object described for this task, with no mark or score of any kind.</reminder>`;
    const raw = await ai.complete({ system, user: message, temperature, maxTokens: 700 });
    try {
      const parsed = schema.parse(normalize(extractJson(raw)));
      problem = check(parsed) || "";
      if (!problem) return parsed;
    } catch (e) {
      problem = e instanceof z.ZodError ? "wrong structure" : "not JSON";
    }
  }
  throw new HttpError(502, "Le tuteur n'a pas pu répondre. Réessayez dans un instant.");
}

// ── Les deux tâches ─────────────────────────────────────
/** ctx = { profile, ageGroup, feedbackLanguage, lessonExcerpts, focus } */
export async function askQuestion(ctx, previousQuestions = []) {
  const prev = previousQuestions.slice(-8).map((q) => `- ${cleanStudentText(q, 300)}`).join("\n") || "(none)";
  const out = await runTask({
    system: buildSystemPrompt(ctx),
    user: `<task>ASK</task>\n<previous_questions>\n${prev}\n</previous_questions>`,
    schema: askSchema,
    temperature: 0.6,
  });
  const kw = new Set(ctx.profile.keywords.map((k) => k.id));
  const gr = new Set(ctx.profile.grammar.map((g) => g.id));
  return {
    ...out,
    targetKeywordIds: out.targetKeywordIds.filter((i) => kw.has(i)),
    targetGrammarIds: out.targetGrammarIds.filter((i) => gr.has(i)),
  };
}

export async function giveFeedback(ctx, question, transcript) {
  return runTask({
    system: buildSystemPrompt(ctx),
    user:
      `<task>FEEDBACK</task>\n<question>${cleanStudentText(question.question, 400)}</question>\n` +
      `<target_ids keywords="${(question.targetKeywordIds || []).join(",")}" grammar="${(question.targetGrammarIds || []).join(",")}" />\n` +
      `<student_transcript>\n${cleanStudentText(transcript)}\n</student_transcript>`,
    schema: feedbackSchema,
    temperature: 0.3,
    normalize: (o) => ({ ...o, improvements: Array.isArray(o.improvements) ? o.improvements.slice(0, 2) : [] }),
    check: (f) => (containsScore(f) ? "it contained a mark or score" : null),
  });
}
