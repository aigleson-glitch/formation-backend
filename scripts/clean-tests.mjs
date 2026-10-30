// Supprime les formations de test « [TEST] … » laissées par les scripts smoke (et leurs inscriptions, copies, fichiers).
//   node scripts/clean-tests.mjs         → liste seulement, ne supprime rien
//   node scripts/clean-tests.mjs --yes   → supprime
// Ne touche qu'aux formations dont le titre commence par « [TEST] ». Les comptes de test ne sont pas supprimés.
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { removeBytes } from "../src/lib/fileStore.js";

const yes = process.argv.includes("--yes");

async function main() {
  const courses = await prisma.course.findMany({
    where: { title: { startsWith: "[TEST]" } },
    select: { id: true, title: true, _count: { select: { enrollments: true } } },
  });
  if (courses.length === 0) return console.log("Aucune formation [TEST] : rien à faire.");
  for (const c of courses) console.log(`- ${c.title} (${c._count.enrollments} inscription(s))`);
  if (!yes) return console.log(`\n${courses.length} formation(s) trouvée(s). Relancez avec --yes pour les supprimer.`);

  const ids = courses.map((c) => c.id);
  const assessments = await prisma.assessment.findMany({ where: { module: { courseId: { in: ids } } }, select: { id: true } });
  const files = await prisma.submissionFile.findMany({ where: { assessmentId: { in: assessments.map((a) => a.id) } }, select: { storageKey: true } });
  // Les paiements et les inscriptions bloquent la suppression d'une formation (Restrict) : on les retire d'abord.
  // Les certificats, copies, tentatives et progressions partent avec les inscriptions (suppression en cascade).
  await prisma.$transaction([
    prisma.payment.deleteMany({ where: { courseId: { in: ids } } }),
    prisma.enrollment.deleteMany({ where: { courseId: { in: ids } } }),
    prisma.course.deleteMany({ where: { id: { in: ids } } }),
  ]);
  for (const f of files) await removeBytes(f.storageKey).catch(() => {});
  console.log(`\n${courses.length} formation(s) de test supprimée(s), ${files.length} fichier(s) retiré(s).`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
