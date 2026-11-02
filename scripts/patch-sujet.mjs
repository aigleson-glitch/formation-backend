// Branche le sujet téléversé dans le code existant. À lancer une fois, dans le dossier backend : node scripts/patch-sujet.mjs
import { readFileSync, writeFileSync } from 'node:fs';

let errors = 0;
function patch(file, marker, steps) {
  let raw = readFileSync(file, 'utf8');
  if (raw.includes(marker)) return console.log(`${file} : déjà appliqué`);
  const crlf = raw.includes('\r\n');
  let s = raw.replace(/\r\n/g, '\n');
  for (const [from, to] of steps) {
    if (!s.includes(from)) { console.error(`ERREUR ${file} : repère introuvable :\n${from}`); errors++; return; }
    s = s.replace(from, () => to);
  }
  writeFileSync(file, crlf ? s.replace(/\n/g, '\r\n') : s);
  console.log(`${file} : corrigé`);
}

patch('prisma/schema.prisma', 'attachment_key', [[
  '  attachmentName String?      @map("attachment_name")\n',
  '  attachmentName String?      @map("attachment_name")\n  attachmentKey  String?      @map("attachment_key")  // sujet téléversé (fichier sur le disque), exclusif du lien\n  attachmentMime String?      @map("attachment_mime")\n  attachmentSize Int?         @map("attachment_size")\n',
]]);

patch('src/app.js', 'assignmentSubjectRoutes', [
  ['import fileRoutes from "./routes/files.js";\n', 'import fileRoutes from "./routes/files.js";\nimport assignmentSubjectRoutes from "./routes/assignmentSubject.js";\n'],
  ['  app.use("/", fileRoutes);\n', '  app.use("/", fileRoutes);\n  app.use("/", assignmentSubjectRoutes);\n'],
]);

patch('src/routes/assignment.js', 'attachmentKey', [[
  "    attachment: assessment.attachmentUrl ? { url: assessment.attachmentUrl, name: assessment.attachmentName } : null,\n",
  "    attachment: assessment.attachmentKey ? { file: true, name: assessment.attachmentName }\n      : assessment.attachmentUrl ? { url: assessment.attachmentUrl, name: assessment.attachmentName } : null,\n",
]]);

patch('src/routes/studioAssignment.js', 'removeBytes', [
  ["import { fileView } from '../lib/uploadRules.js';\n", "import { fileView } from '../lib/uploadRules.js';\nimport { removeBytes } from '../lib/fileStore.js';\n"],
  ["    data.attachmentName = url ? name : null; // retirer le lien retire aussi le nom\n",
   "    data.attachmentName = url ? name : null; // retirer le lien retire aussi le nom\n    if (url && a.attachmentKey) Object.assign(data, { attachmentKey: null, attachmentMime: null, attachmentSize: null }); // un lien remplace le fichier\n"],
  ["  const updated = await prisma.assessment.update({ where: { id: a.id }, data });\n",
   "  const updated = await prisma.assessment.update({ where: { id: a.id }, data });\n  if (data.attachmentKey === null && a.attachmentKey) await removeBytes(a.attachmentKey).catch(() => {});\n"],
  ["  await prisma.assessment.delete({ where: { id: a.id } });\n",
   "  await prisma.assessment.delete({ where: { id: a.id } });\n  if (a.attachmentKey) await removeBytes(a.attachmentKey).catch(() => {});\n"],
]);

if (errors) { console.error(`\n${errors} fichier(s) non modifié(s) : envoyez-moi le message ci-dessus.`); process.exit(1); }
console.log('\nSuite : npx prisma migrate dev --name assignment_subject_file   (si Prisma propose de créer une migration, acceptez ; sinon : npx prisma migrate deploy)\nPuis : npx prisma generate, relancer l\'API, node scripts/smoke-subject.mjs');
