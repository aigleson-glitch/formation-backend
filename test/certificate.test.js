import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCode, normalizeCode, publicHolderName, CODE_PATTERN } from "../src/lib/certificate.js";

test("generateCode : format CERT-XXXX-XXXX-XXXX, sans caractères ambigus, tous différents", () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const c = generateCode();
    assert.match(c, CODE_PATTERN);
    assert.doesNotMatch(c.slice(5), /[01OIL]/);
    seen.add(c);
  }
  assert.equal(seen.size, 2000);
});

test("normalizeCode : saisie tolérante", () => {
  assert.equal(normalizeCode("cert-7kq2-m9xd-4tfh"), "CERT-7KQ2-M9XD-4TFH");
  assert.equal(normalizeCode(" CERT 7KQ2 M9XD 4TFH "), "CERT-7KQ2-M9XD-4TFH");
  assert.equal(normalizeCode("7KQ2M9XD4TFH"), "CERT-7KQ2-M9XD-4TFH");
});

test("normalizeCode : formats impossibles refusés", () => {
  assert.equal(normalizeCode(""), null);
  assert.equal(normalizeCode(undefined), null);
  assert.equal(normalizeCode("CERT-7KQ2-M9XD"), null);
  assert.equal(normalizeCode("CERT-0000-1111-OOOO"), null, "caractères exclus de l'alphabet");
  assert.equal(normalizeCode("../../etc/passwd"), null);
  assert.equal(normalizeCode("x".repeat(500)), null);
});

test("publicHolderName : complet pour un adulte, initiale pour un mineur", () => {
  assert.equal(publicHolderName({ firstName: "Marie", lastName: "Ngoma", ageGroup: "adult" }), "Marie Ngoma");
  assert.equal(publicHolderName({ firstName: "Petit", lastName: "Mbemba", ageGroup: "child" }), "Petit M.");
  assert.equal(publicHolderName({ firstName: " Jean ", lastName: " ondo ", ageGroup: "teen" }), "Jean O.");
});
