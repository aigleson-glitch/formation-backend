// Règle du certificat : la formation n'est « terminée » (et le certificat émis) qu'une fois les leçons terminées,
// les évaluations obligatoires réussies ET chaque évaluation facultative tentée (quiz) ou rendue (devoir). Idempotent.
//   node scripts/patch-certificat-regle.mjs      (à lancer dans le dossier backend)
import { readFileSync, writeFileSync } from "node:fs";

function patch(file, edits, doneMarker) {
  let s = readFileSync(file, "utf8");
  if (s.includes(doneMarker)) return console.log(`${file} : déjà appliqué`);
  const eol = s.includes("\r\n") ? "\r\n" : "\n";
  s = s.replace(/\r\n/g, "\n");
  for (const [from, to] of edits) {
    if (!s.includes(from)) { console.error(`ERREUR : texte attendu introuvable dans ${file} (fichier modifié ?). Envoyez-moi ce fichier.`); process.exit(1); }
    s = s.replace(from, () => to);
  }
  writeFileSync(file, s.replace(/\n/g, eol));
  console.log(`${file} : corrigé`);
}

const COURSE_IS_DONE = `/**
 * La formation est terminée quand : toutes les leçons sont terminées, tous les modules sont « compétents »
 * (évaluations obligatoires réussies) ET chaque évaluation facultative a été tentée (quiz) ou rendue (devoir),
 * réussie ou non. Un quiz facultatif sans question ne bloque pas : on ne peut pas le passer.
 */
export async function courseIsDone(enrollmentId, courseId) {
  const inCourse = { chapter: { module: { courseId } } };
  const [modules, totalLessons, doneLessons, optional] = await Promise.all([
    prisma.module.findMany({ where: { courseId }, orderBy: { position: 'asc' } }),
    prisma.lesson.count({ where: inCourse }),
    prisma.lessonProgress.count({ where: { enrollmentId, lesson: inCourse } }),
    prisma.assessment.findMany({ where: { isRequired: false, module: { courseId } }, select: { id: true, type: true, _count: { select: { questions: true } } } }),
  ]);
  if (modules.length === 0 || doneLessons < totalLessons) return false;
  for (const m of modules) {
    if (!(await isModuleCompetent(enrollmentId, m))) return false;
  }
  const todo = optional.filter((a) => !['quiz', 'mcq'].includes(a.type) || a._count.questions > 0);
  if (todo.length === 0) return true;
  const ids = todo.map((a) => a.id);
  const [attempts, subs] = await Promise.all([
    prisma.attempt.findMany({ where: { enrollmentId, assessmentId: { in: ids }, status: 'submitted' }, select: { assessmentId: true } }),
    prisma.submission.findMany({ where: { enrollmentId, assessmentId: { in: ids } }, select: { assessmentId: true } }),
  ]);
  const tried = new Set([...attempts, ...subs].map((x) => x.assessmentId));
  return todo.every((a) => tried.has(a.id));
}

`;

patch("src/lib/progress.js", [
  [`/**\n * Fin de formation : tous les modules sont « compétents » ET toutes les leçons sont terminées.`,
   COURSE_IS_DONE + `/**\n * Fin de formation : voir courseIsDone (leçons, évaluations obligatoires réussies, évaluations facultatives tentées).`],
  [`  const modules = await prisma.module.findMany({ where: { courseId: e.courseId }, orderBy: { position: 'asc' } });
  if (modules.length === 0) return false;

  const inCourse = { chapter: { module: { courseId: e.courseId } } };
  const [totalLessons, doneLessons] = await Promise.all([
    prisma.lesson.count({ where: inCourse }),
    prisma.lessonProgress.count({ where: { enrollmentId: e.id, lesson: inCourse } }),
  ]);
  if (doneLessons < totalLessons) return false;
  for (const m of modules) {
    if (!(await isModuleCompetent(e.id, m))) return false;
  }
`, `  if (!(await courseIsDone(e.id, e.courseId))) return false;
`],
], "export async function courseIsDone");

// Un devoir facultatif rendu peut être la dernière chose qui manquait
patch("src/routes/assignment.js", [
  [`import { isModuleUnlocked } from '../lib/progress.js';`, `import { isModuleUnlocked, completeEnrollmentIfDone } from '../lib/progress.js';`],
  [`    res.status(201).json(ownSubmissionView(created));`,
   `    await completeEnrollmentIfDone(enrollment.id).catch((err) => console.error('Fin de formation :', err.message));\n    res.status(201).json(ownSubmissionView(created));`],
], "completeEnrollmentIfDone");
