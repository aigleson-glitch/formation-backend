// Refuse une nouvelle tentative quand la note maximale (100 %) est déjà obtenue. Idempotent.
import { readFileSync, writeFileSync } from "node:fs";
const f = "src/routes/quiz.js";
let s = readFileSync(f, "utf8");
if (s.includes("Note maximale déjà obtenue")) { console.log("déjà appliqué"); process.exit(0); }
const old = "    if (used >= assessment.maxAttempts) throw new HttpError(403, 'Nombre maximal de tentatives atteint');";
if (!s.includes(old)) { console.error("ERREUR : ligne attendue introuvable dans " + f + " (fichier modifié ?). Envoyez-moi ce fichier."); process.exit(1); }
s = s.replace(old, `    if (await prisma.attempt.count({ where: { ...where, status: 'submitted', scorePct: { gte: 100 } } })) throw new HttpError(403, 'Note maximale déjà obtenue : inutile de recommencer');\n` + old);
writeFileSync(f, s);
console.log("quiz.js corrigé");
