import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chapterProfileSchema, describeFocus } from "../src/lib/chapterProfile.js";

const example = () => JSON.parse(readFileSync(new URL("../prisma/examples/chapter-profile.example.json", import.meta.url), "utf8"));

test("le profil d'exemple est valide", () => {
  const r = chapterProfileSchema.safeParse(example());
  assert.equal(r.success, true, r.success ? "" : JSON.stringify(r.error.flatten()));
});

test("une tâche qui référence un mot-clé inexistant est refusée", () => {
  const p = example();
  p.speakingTasks[0].targetKeywordIds = ["kw-inconnu"];
  const r = chapterProfileSchema.safeParse(p);
  assert.equal(r.success, false);
  assert.match(JSON.stringify(r.error.issues), /Mot-clé inconnu/);
});

test("des identifiants en double sont refusés", () => {
  const p = example();
  p.keywords.push({ ...p.keywords[0] });
  assert.equal(chapterProfileSchema.safeParse(p).success, false);
});

test("un niveau hors CECRL est refusé", () => {
  const p = example();
  p.level = "D9";
  assert.equal(chapterProfileSchema.safeParse(p).success, false);
});

test("describeFocus", () => {
  const p = chapterProfileSchema.parse(example());
  assert.equal(describeFocus(p, { type: "all" }), "whole chapter");
  assert.equal(describeFocus(p, { type: "grammar", grammarId: "gr-present-perfect-form" }), "Grammar: Present perfect: form");
  assert.match(describeFocus(p, { type: "vocabulary" }), /^Vocabulary: travel abroad/);
});
