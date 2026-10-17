/**
 * Appels aux services d'IA (Whisper pour la voix, un LLM pour le tuteur).
 * Aucun SDK : simple fetch, donc aucune dépendance en plus. Les clés ne quittent jamais le serveur.
 * L'objet `ai` est exporté pour pouvoir être remplacé dans les tests.
 */
import { HttpError } from "./http.js";

const WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

function need(name) {
  const v = process.env[name];
  if (!v) throw new HttpError(503, "Le service d'IA n'est pas configuré pour le moment.");
  return v;
}

const extFromMime = (m = "") =>
  m.includes("webm") ? "webm" : m.includes("mp4") || m.includes("m4a") ? "m4a" : m.includes("ogg") ? "ogg" : m.includes("wav") ? "wav" : m.includes("mpeg") ? "mp3" : "webm";

export const wordCount = (s = "") => (s.trim().match(/\S+/g) || []).length;

/** Transcrit un enregistrement. Retourne le texte et des indicateurs de confiance. */
async function transcribe({ buffer, mimeType, hintTerms = [] }) {
  const key = need("OPENAI_API_KEY");
  const fd = new FormData();
  fd.append("file", new Blob([buffer], { type: mimeType || "audio/webm" }), `answer.${extFromMime(mimeType)}`);
  fd.append("model", process.env.WHISPER_MODEL || "whisper-1");
  fd.append("language", "en");
  fd.append("temperature", "0");
  fd.append("response_format", "verbose_json");
  // Courte liste de termes du chapitre : aide à l'orthographe, sans donner de phrases à « deviner »
  if (hintTerms.length) fd.append("prompt", hintTerms.slice(0, 15).join(", "));

  let res;
  try {
    res = await fetch(WHISPER_URL, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd, signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new HttpError(502, "Le service de transcription est injoignable. Réessayez dans un instant.");
  }
  if (!res.ok) {
    console.error("Transcription refusée", res.status, (await res.text().catch(() => "")).slice(0, 300));
    throw new HttpError(502, "La transcription a échoué. Réessayez.");
  }
  const j = await res.json();
  const segs = j.segments || [];
  const avg = (f) => (segs.length ? segs.reduce((a, s) => a + (s[f] ?? 0), 0) / segs.length : null);
  return { text: (j.text || "").trim(), durationSec: j.duration ?? null, avgLogprob: avg("avg_logprob"), noSpeechProb: avg("no_speech_prob") };
}

/** Whisper invente parfois des phrases sur du silence : on les écarte avec ses propres indicateurs. */
export const isUnintelligible = ({ text, avgLogprob, noSpeechProb }) =>
  wordCount(text) < 2 || (noSpeechProb != null && noSpeechProb > 0.6 && avgLogprob != null && avgLogprob < -1);

/** Demande une réponse au LLM. Retourne le texte brut. */
async function complete({ system, user, temperature = 0.3, maxTokens = 700 }) {
  const key = need("ANTHROPIC_API_KEY");
  const call = (withTemperature) =>
    fetch(MESSAGES_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.TUTOR_MODEL || "claude-sonnet-5-5",
        max_tokens: maxTokens,
        ...(withTemperature && { temperature }),
        system,
        messages: [{ role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(45_000),
    });

  let res;
  try {
    res = await call(true);
    if (res.status === 400) {
      const body = await res.clone().text();
      if (body.includes("temperature")) res = await call(false); // certains modèles refusent ce réglage
    }
  } catch {
    throw new HttpError(502, "Le tuteur est injoignable. Réessayez dans un instant.");
  }
  if (!res.ok) {
    console.error("Tuteur IA refusé", res.status, (await res.text().catch(() => "")).slice(0, 300));
    throw new HttpError(502, "Le tuteur n'a pas pu répondre. Réessayez.");
  }
  const j = await res.json();
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

export const ai = { transcribe, complete };
