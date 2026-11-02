// Repère les formations « terminées » (et leurs certificats) qui ne respectent pas la règle actuelle :
// leçons terminées, évaluations obligatoires réussies, évaluations facultatives tentées ou rendues.
//   node scripts/recheck-certificates.mjs         → liste seulement, ne change rien
//   node scripts/recheck-certificates.mjs --yes   → remet ces inscriptions « en cours » et supprime leur certificat
// Les inscriptions repassent en cours : le certificat sera émis de nouveau dès que la condition sera remplie.
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { courseIsDone } from "../src/lib/progress.js";

const yes = process.argv.includes("--yes");

async function main() {
  const done = await prisma.enrollment.findMany({
    where: { status: "completed" },
    select: { id: true, courseId: true, course: { select: { title: true } }, user: { select: { firstName: true, lastName: true } }, certificate: { select: { code: true } } },
  });
  const bad = [];
  for (const e of done) if (!(await courseIsDone(e.id, e.courseId))) bad.push(e);
  console.log(`${done.length} formation(s) terminée(s) examinée(s), ${bad.length} ne respecte(nt) pas la règle.`);
  for (const e of bad) console.log(`- ${e.user.firstName} ${e.user.lastName} : ${e.course.title}${e.certificate ? ` (certificat ${e.certificate.code})` : ""}`);
  if (bad.length === 0 || !yes) return bad.length ? console.log("\nRelancez avec --yes pour les remettre en cours et retirer leur certificat.") : undefined;

  const ids = bad.map((e) => e.id);
  await prisma.$transaction([
    prisma.certificate.deleteMany({ where: { enrollmentId: { in: ids } } }),
    prisma.enrollment.updateMany({ where: { id: { in: ids } }, data: { status: "active", completedAt: null } }),
  ]);
  console.log(`\n${bad.length} inscription(s) remise(s) en cours, certificats retirés.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
