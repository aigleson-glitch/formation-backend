import { test } from "node:test";
import assert from "node:assert/strict";
import { checkUpload, safeFileName, contentDisposition, extensionOf, MAX_UPLOAD_BYTES, fileView } from "../src/lib/uploadRules.js";

const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(20)]);
const doc = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(20)]);

test("checkUpload : formats acceptés, type lu dans le contenu", () => {
  assert.deepEqual(checkUpload({ buffer: pdf, fileName: "devoir.pdf" }), { ok: true, mime: "application/pdf", name: "devoir.pdf" });
  assert.equal(checkUpload({ buffer: png, fileName: "schema.PNG" }).mime, "image/png");
  assert.equal(checkUpload({ buffer: jpg, fileName: "photo.jpeg" }).mime, "image/jpeg");
  assert.equal(checkUpload({ buffer: zip, fileName: "projet.zip" }).mime, "application/zip");
  assert.match(checkUpload({ buffer: zip, fileName: "rapport.docx" }).mime, /wordprocessingml/);
  assert.equal(checkUpload({ buffer: doc, fileName: "ancien.doc" }).mime, "application/msword");
});

test("checkUpload : une extension qui ne correspond pas au contenu est refusée", () => {
  assert.equal(checkUpload({ buffer: Buffer.from("<script>alert(1)</script>"), fileName: "faux.pdf" }).status, 415);
  assert.equal(checkUpload({ buffer: pdf, fileName: "pdf-deguise.png" }).status, 415);
  assert.equal(checkUpload({ buffer: zip, fileName: "macro.doc" }).status, 415);
});

test("checkUpload : types interdits, même avec un contenu plausible", () => {
  for (const name of ["virus.exe", "page.html", "script.js", "image.svg", "tableur.xlsx", "sans-extension", "double.pdf.exe", "fichier."]) {
    assert.equal(checkUpload({ buffer: pdf, fileName: name }).status, 415, name);
  }
});

test("checkUpload : vide, trop gros, sans nom, pas un fichier brut", () => {
  assert.equal(checkUpload({ buffer: Buffer.alloc(0), fileName: "a.pdf" }).status, 422);
  assert.equal(checkUpload({ buffer: Buffer.concat([pdf, Buffer.alloc(MAX_UPLOAD_BYTES)]), fileName: "gros.pdf" }).status, 413);
  assert.equal(checkUpload({ buffer: pdf, fileName: "" }).status, 422);
  assert.equal(checkUpload({ buffer: { not: "a buffer" }, fileName: "a.pdf" }).status, 415);
});

test("safeFileName : pas de chemin, pas de caractères de contrôle", () => {
  assert.equal(safeFileName("..\\..\\windows\\system32\\a.pdf"), "a.pdf");
  assert.equal(safeFileName("../../etc/passwd.pdf"), "passwd.pdf");
  assert.equal(safeFileName(encodeURIComponent("Rapport été.pdf")), "Rapport été.pdf");
  assert.equal(safeFileName("a\u0000b\nc.pdf"), "abc.pdf");
  assert.ok(safeFileName("x".repeat(400) + ".pdf").length <= 150);
  assert.ok(safeFileName("x".repeat(400) + ".pdf").endsWith(".pdf"));
  assert.equal(safeFileName("%E0%A4%A.pdf"), "%E0%A4%A.pdf", "un nom mal encodé ne fait pas planter");
});

test("extensionOf et contentDisposition", () => {
  assert.equal(extensionOf("Archive.TAR.GZ"), "gz");
  assert.equal(extensionOf("rien"), "");
  const h = contentDisposition('Rapport "été".pdf');
  assert.match(h, /^attachment; /);
  assert.doesNotMatch(h, /inline/);
  assert.doesNotMatch(h.split("filename*")[0], /é|"été/);
  assert.match(h, /filename\*=UTF-8''Rapport%20%22%C3%A9t%C3%A9%22\.pdf/);
});

test("fileView : n'expose ni la clé de stockage ni le propriétaire", () => {
  const v = fileView({ id: "1", originalName: "a.pdf", mimeType: "application/pdf", sizeBytes: 12, storageKey: "secret", ownerId: "u" });
  assert.deepEqual(v, { id: "1", name: "a.pdf", mimeType: "application/pdf", sizeBytes: 12 });
  assert.equal(fileView(null), null);
});
