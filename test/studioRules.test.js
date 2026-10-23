import { test } from "node:test";
import assert from "node:assert/strict";
import { hasMinors, minorsRuleProblem, reorderProblem, mediaProblem, isPlayable } from "../src/lib/studioRules.js";

const certified = { canTeachMinors: true, isActive: true };
const notCertified = { canTeachMinors: false, isActive: true };

test("hasMinors : enfants et ados comptent, pas les adultes", () => {
  assert.equal(hasMinors(["adult"]), false);
  assert.equal(hasMinors(["adult", "teen"]), true);
  assert.equal(hasMinors(["child"]), true);
  assert.equal(hasMinors([]), false);
});

test("règle 15 : formation adulte, aucune contrainte", () => {
  assert.equal(minorsRuleProblem({ audiences: ["adult"], instructors: [notCertified], published: true }), null);
  assert.equal(minorsRuleProblem({ audiences: ["adult"], instructors: [], published: true }), null);
});

test("règle 15 : un formateur non habilité est refusé sur une formation pour mineurs", () => {
  assert.match(minorsRuleProblem({ audiences: ["child"], instructors: [certified, notCertified] }), /habilité/);
});

test("règle 15 : brouillon sans formateur accepté, publication refusée sans formateur habilité", () => {
  assert.equal(minorsRuleProblem({ audiences: ["teen"], instructors: [], published: false }), null);
  assert.match(minorsRuleProblem({ audiences: ["teen"], instructors: [], published: true }), /au moins un formateur/);
  assert.equal(minorsRuleProblem({ audiences: ["teen"], instructors: [certified], published: true }), null);
});

test("règle 15 : un formateur désactivé ne compte pas", () => {
  const gone = { canTeachMinors: true, isActive: false };
  assert.match(minorsRuleProblem({ audiences: ["child"], instructors: [gone], published: true }), /au moins un formateur/);
  // un formateur désactivé et non habilité ne bloque pas non plus
  assert.equal(minorsRuleProblem({ audiences: ["child"], instructors: [certified, { canTeachMinors: false, isActive: false }], published: true }), null);
});

test("reorderProblem : liste exacte exigée", () => {
  const cur = ["a", "b", "c"];
  assert.equal(reorderProblem(["c", "a", "b"], cur), null);
  assert.ok(reorderProblem(["a", "b"], cur), "élément manquant");
  assert.ok(reorderProblem(["a", "b", "c", "d"], cur), "élément en trop");
  assert.ok(reorderProblem(["a", "a", "b"], cur), "doublon");
  assert.ok(reorderProblem(["a", "b", "x"], cur), "élément étranger");
});

test("mediaProblem : média obligatoire hors texte", () => {
  assert.equal(mediaProblem("text", undefined), null);
  assert.ok(mediaProblem("video", undefined));
  assert.ok(mediaProblem("pdf", null));
  assert.equal(mediaProblem("audio", "https://exemple.com/a.mp3"), null);
});

test("isPlayable : un quiz vide n'est pas jouable", () => {
  assert.equal(isPlayable("quiz", 0), false);
  assert.equal(isPlayable("mcq", 0), false);
  assert.equal(isPlayable("quiz", 3), true);
  assert.equal(isPlayable("assignment", 0), true); // les devoirs (phase 3) n'ont pas de questions
});
