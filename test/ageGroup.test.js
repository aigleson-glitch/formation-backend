import { test } from "node:test";
import assert from "node:assert/strict";
import { ageGroupFromBirthDate, computeAge } from "../src/lib/ageGroup.js";

const now = new Date("2026-10-11T00:00:00Z");

test("moins de 5 ans : aucun groupe", () => {
  assert.equal(ageGroupFromBirthDate("2022-01-01", now), null);
});
test("5 à 12 ans : enfant", () => {
  assert.equal(ageGroupFromBirthDate("2021-10-11", now), "child"); // 5 ans pile
  assert.equal(ageGroupFromBirthDate("2013-10-12", now), "child"); // 12 ans (13 demain)
});
test("13 à 17 ans : ado", () => {
  assert.equal(ageGroupFromBirthDate("2013-10-11", now), "teen"); // 13 ans pile
  assert.equal(ageGroupFromBirthDate("2008-10-12", now), "teen"); // 17 ans (18 demain)
});
test("18 ans et plus : adulte, passage automatique le jour de l anniversaire", () => {
  assert.equal(ageGroupFromBirthDate("2008-10-11", now), "adult");
  assert.equal(computeAge("2008-10-11", now), 18);
});
