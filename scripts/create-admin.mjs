// Crée le premier administrateur (le seed de démonstration est interdit en production).
//
//   PowerShell :  $env:ADMIN_PASSWORD = "un mot de passe long et unique"
//                 node scripts/create-admin.mjs prenom.nom@exemple.com Prénom Nom
//   Linux/Mac  :  ADMIN_PASSWORD='...' node scripts/create-admin.mjs prenom.nom@exemple.com Prénom Nom
//
// Le mot de passe se passe par variable d'environnement, jamais en argument (il resterait dans l'historique du terminal).
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/auth.js";

const [emailArg, firstName, ...lastParts] = process.argv.slice(2);
const lastName = lastParts.join(" ");
const password = process.env.ADMIN_PASSWORD ?? "";
const email = (emailArg ?? "").trim().toLowerCase();

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function main() {
  if (!email.includes("@") || !firstName || !lastName) {
    return fail("Usage : ADMIN_PASSWORD=... node scripts/create-admin.mjs email@exemple.com Prénom Nom");
  }
  if (password.length < 12) return fail("ADMIN_PASSWORD doit contenir au moins 12 caractères.");
  if (password === "ChangeMe123!") return fail("Ce mot de passe est celui de la démonstration : choisissez-en un autre.");

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return fail(`Un compte existe déjà avec cet e-mail (rôle : ${existing.role}). Rien n'a été modifié.`);

  const admin = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(password), firstName, lastName, role: "admin", isActive: true },
  });
  console.log(`Administrateur créé : ${admin.email}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
