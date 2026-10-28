// Branche les routes de fichiers dans src/app.js (2 lignes) et ignore le dossier des envois dans Git.
// Sans danger si on le lance deux fois, et sans toucher au reste de ton app.js.
//   node scripts/install-files.mjs
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

const APP = 'src/app.js';
const src = readFileSync(APP, 'utf8');
const eol = src.includes('\r\n') ? '\r\n' : '\n';
let out = src;
let changed = false;

if (!/routes\/files\.js/.test(out)) {
  const importLine = 'import fileRoutes from "./routes/files.js";';
  const anchorImport = out.match(/^import assignmentRoutes from .*$/m) ?? [...out.matchAll(/^import .*$/gm)].pop();
  if (!anchorImport) { console.error('Impossible de trouver les lignes « import » dans src/app.js : rien n\'a été modifié.'); process.exit(1); }
  out = out.replace(anchorImport[0], `${anchorImport[0]}${eol}${importLine}`);
  changed = true;
}
if (!/app\.use\(\s*["']\/["']\s*,\s*fileRoutes\s*\)/.test(out)) {
  const anchorUse = out.match(/^(\s*)app\.use\(\s*["']\/["']\s*,\s*assignmentRoutes\s*\);.*$/m);
  if (!anchorUse) { console.error('Ligne « app.use("/", assignmentRoutes) » introuvable dans src/app.js : rien n\'a été modifié. Ajoute à la main : app.use("/", fileRoutes);'); process.exit(1); }
  out = out.replace(anchorUse[0], `${anchorUse[0]}${eol}${anchorUse[1]}app.use("/", fileRoutes);`);
  changed = true;
}
if (changed) { writeFileSync(APP, out); console.log('src/app.js : routes de fichiers ajoutées.'); } else console.log('src/app.js : déjà à jour.');

const ignore = existsSync('.gitignore') ? readFileSync('.gitignore', 'utf8') : '';
if (!/^\/?uploads\/?\s*$/m.test(ignore)) { appendFileSync('.gitignore', `${ignore && !ignore.endsWith('\n') ? eol : ''}uploads/${eol}`); console.log('.gitignore : dossier uploads/ ignoré.'); }
else console.log('.gitignore : déjà à jour.');
