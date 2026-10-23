import { test } from "node:test";
import assert from "node:assert/strict";
import { contentProblem, submitDecision, gradeProblem, isPassed, canRegrade } from "../src/lib/assignmentRules.js";

test("contentProblem : texte ou lien, au moins un", () => {
  assert.ok(contentProblem({}));
  assert.ok(contentProblem({ content: "   ", linkUrl: "" }));
  assert.equal(contentProblem({ content: "Mon devoir" }), null);
  assert.equal(contentProblem({ linkUrl: "https://github.com/moi/projet" }), null);
});

test("contentProblem : lien en https uniquement", () => {
  assert.match(contentProblem({ linkUrl: "http://exemple.com" }), /https/);
  assert.match(contentProblem({ linkUrl: "javascript:alert(1)" }), /https/);
  assert.match(contentProblem({ linkUrl: "pas un lien" }), /pas valide/);
  assert.ok(contentProblem({ content: "x".repeat(20001) }));
});

test("submitDecision : première remise acceptée", () => {
  assert.deepEqual(submitDecision({ maxAttempts: 3, submissions: [] }), { ok: true, attemptsLeft: 3 });
});

test("submitDecision : refus si réussi ou en attente", () => {
  assert.equal(submitDecision({ maxAttempts: 3, submissions: [{ status: "graded", passed: true }] }).status, 409);
  assert.equal(submitDecision({ maxAttempts: 3, submissions: [{ status: "submitted", passed: null }] }).status, 409);
  assert.equal(submitDecision({ maxAttempts: 3, submissions: [{ status: "in_review", passed: null }] }).status, 409);
});

test("submitDecision : les copies corrigées et ratées consomment une tentative, pas « à resoumettre »", () => {
  const failed = { status: "graded", passed: false };
  assert.equal(submitDecision({ maxAttempts: 2, submissions: [failed] }).attemptsLeft, 1);
  assert.equal(submitDecision({ maxAttempts: 2, submissions: [failed, failed] }).status, 403);
  const resub = { status: "resubmit", passed: false };
  assert.equal(submitDecision({ maxAttempts: 1, submissions: [resub] }).ok, true);
});

test("gradeProblem : note et commentaire", () => {
  assert.equal(gradeProblem({ decision: "graded", scorePct: 80, feedback: "Bien" }), null);
  assert.equal(gradeProblem({ decision: "graded", scorePct: 0, feedback: "Insuffisant" }), null);
  assert.ok(gradeProblem({ decision: "graded", scorePct: 80, feedback: " " }), "commentaire obligatoire");
  assert.ok(gradeProblem({ decision: "graded", feedback: "ok" }), "note obligatoire");
  assert.ok(gradeProblem({ decision: "graded", scorePct: 101, feedback: "ok" }));
  assert.ok(gradeProblem({ decision: "graded", scorePct: -1, feedback: "ok" }));
  assert.ok(gradeProblem({ decision: "graded", scorePct: "80", feedback: "ok" }), "une chaîne n'est pas une note");
  assert.equal(gradeProblem({ decision: "resubmit", feedback: "Refaites la partie 2" }), null);
  assert.ok(gradeProblem({ decision: "resubmit" }));
  assert.ok(gradeProblem({ decision: "autre", feedback: "x" }));
});

test("isPassed : seuil inclus", () => {
  assert.equal(isPassed(70, 70), true);
  assert.equal(isPassed(69.99, 70), false);
});

test("canRegrade : seulement la dernière copie, seulement si corrigée", () => {
  assert.equal(canRegrade({ status: "graded", attemptNo: 2 }, 2), true);
  assert.equal(canRegrade({ status: "graded", attemptNo: 1 }, 2), false);
  assert.equal(canRegrade({ status: "resubmit", attemptNo: 2 }, 2), false);
});
