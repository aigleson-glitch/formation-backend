// Test de bout en bout : fichiers joints aux copies (envoi, remise, téléchargement, droits, refus).
//   node scripts/smoke-files.mjs      (l'API tourne : npm run dev dans une autre fenêtre)
// Crée des comptes et une formation « [TEST] ... » (dépubliée / désactivés à la fin).
const API = process.env.API_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'ChangeMe123!';
const stamp = Date.now();
const PW = 'MotDePasseTest-2026';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  OK  ' : ' ECHEC'}  ${label}${ok ? '' : detail ? `  →  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
}
async function call(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json };
}
// Envoi d'un fichier brut
async function upload(assignmentId, token, bytes, name) {
  const res = await fetch(`${API}/assignments/${assignmentId}/files`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', ...(token && { Authorization: `Bearer ${token}` }), ...(name !== undefined && { 'X-File-Name': encodeURIComponent(name) }) },
    body: bytes,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json };
}
async function download(id, token) {
  const res = await fetch(`${API}/files/${id}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
}
const must = (r, expected, what) => {
  if (r.status !== expected) throw new Error(`${what} : statut ${r.status} (attendu ${expected}) ${JSON.stringify(r.json)}`);
  return r.json;
};
const login = async (identifier, password = PW) => must(await call('POST', '/auth/login', null, { identifier, password }), 200, `connexion ${identifier}`).token;

// Contenus de test
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('contenu du devoir '.repeat(50))]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

async function main() {
  console.log(`API : ${API}\n`);
  const tA = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const categories = must(await call('GET', '/categories'), 200, 'catégories');
  const categoryId = (Array.isArray(categories) ? categories : categories.categories)[0].id;
  const staff = [];
  const mkStaff = async (label) => {
    const u = must(await call('POST', '/admin/users', tA, { role: 'instructor', email: `fic.${label}.${stamp}@example.com`, password: PW, firstName: 'Test', lastName: label, canTeachMinors: true }), 201, label);
    staff.push(u.id);
    return u;
  };
  const instrA = await mkStaff('formateurA');
  const instrB = await mkStaff('formateurB');
  const tI = await login(instrA.email);
  const tB = await login(instrB.email);

  const course = must(await call('POST', '/studio/courses', tI, { categoryId, title: `[TEST] Fichiers ${stamp}`, audiences: ['adult', 'child'] }), 201, 'cours');
  const m = must(await call('POST', `/studio/courses/${course.id}/modules`, tI, { title: 'Module' }), 201, 'module');
  const c = must(await call('POST', `/studio/modules/${m.id}/chapters`, tI, { title: 'Chapitre' }), 201, 'chapitre');
  must(await call('POST', `/studio/chapters/${c.id}/lessons`, tI, { title: 'Leçon', content: 'Texte' }), 201, 'leçon');
  const assign = must(await call('POST', `/studio/modules/${m.id}/assignments`, tI, { title: 'Devoir avec fichier', maxAttempts: 3 }), 201, 'devoir');
  const assign2 = must(await call('POST', `/studio/modules/${m.id}/assignments`, tI, { title: 'Autre devoir', isRequired: false }), 201, 'devoir 2');
  must(await call('POST', `/studio/courses/${course.id}/publish`, tI, { published: true }), 200, 'publication');

  const reg = async (label, extra = {}) => must(await call('POST', '/auth/register', null, { accountType: 'adult', email: `fic.${label}.${stamp}@example.com`, password: PW, firstName: 'Eleve', lastName: label, birthDate: '1990-01-01', ...extra }), 201, label).token;
  const tS = await reg('Dupont');
  const tOther = await reg('Autre');
  const tOutsider = await reg('Hors');
  must(await call('POST', `/courses/${course.id}/enroll`, tS, {}), 201, 'inscription');
  must(await call('POST', `/courses/${course.id}/enroll`, tOther, {}), 201, 'inscription 2');
  const submit = (id, t, body) => call('POST', `/assignments/${id}/submissions`, t, body);

  // ── Envoi ─────────────────────────────────────────────────────
  console.log('Envoi du fichier');
  check('sans connexion : 401', (await upload(assign.id, null, PDF, 'devoir.pdf')).status === 401);
  check('un élève non inscrit ne peut pas envoyer (403)', (await upload(assign.id, tOutsider, PDF, 'devoir.pdf')).status === 403);
  check('devoir inconnu : 404', (await upload('pas-un-uuid', tS, PDF, 'devoir.pdf')).status === 404);
  check('fichier vide refusé (422)', (await upload(assign.id, tS, Buffer.alloc(0), 'vide.pdf')).status === 422);
  check('faux PDF refusé (415)', (await upload(assign.id, tS, Buffer.from('<script>alert(1)</script>'), 'faux.pdf')).status === 415);
  check('PNG déguisé en PDF refusé (415)', (await upload(assign.id, tS, PNG, 'image.pdf')).status === 415);
  check('exécutable refusé (415)', (await upload(assign.id, tS, PDF, 'virus.exe')).status === 415);
  check('page HTML refusée (415)', (await upload(assign.id, tS, Buffer.from('<html></html>'), 'page.html')).status === 415);
  check('sans nom de fichier : refusé (422)', (await upload(assign.id, tS, PDF, '')).status === 422);
  const tooBig = await upload(assign.id, tS, Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(11 * 1024 * 1024)]), 'gros.pdf');
  check('fichier de plus de 10 Mo refusé (413)', tooBig.status === 413, tooBig);
  const json = await call('PUT', `/assignments/${assign.id}/files`, tS, { not: 'a file' });
  check('corps JSON au lieu d\'un fichier brut refusé (415)', json.status === 415, json);

  const f1 = must(await upload(assign.id, tS, PDF, 'Mon devoir été.pdf'), 201, 'envoi du PDF');
  check('PDF accepté : nom, type et taille renvoyés, sans clé de stockage', f1.name === 'Mon devoir été.pdf' && f1.mimeType === 'application/pdf' && f1.sizeBytes === PDF.length && !('storageKey' in f1), f1);
  const sloppy = must(await upload(assign.id, tS, PNG, '../../etc/schema.PNG'), 201, 'envoi PNG');
  check('nom de fichier nettoyé (pas de chemin)', sloppy.name === 'schema.PNG', sloppy);

  // ── Remise avec fichier ───────────────────────────────────────
  console.log('\nRemise');
  check('fichier d\'un autre élève refusé (422)', (await submit(assign.id, tOther, { fileId: f1.id })).status === 422);
  check('fichier inconnu refusé (422)', (await submit(assign.id, tS, { fileId: '00000000-0000-4000-8000-000000000000' })).status === 422);
  check('fichier envoyé pour un autre devoir refusé (422)', (await submit(assign2.id, tS, { fileId: f1.id })).status === 422);
  check('remise vide (ni texte, ni lien, ni fichier) refusée (422)', (await submit(assign.id, tS, {})).status === 422);
  const mid = await call('GET', `/assignments/${assign.id}`, tS);
  check('après les refus, aucune copie n\'a été créée', mid.json.submissions.length === 0, mid.json.submissions);
  const s1 = must(await submit(assign.id, tS, { fileId: f1.id }), 201, 'remise avec fichier seul');
  check('remise acceptée avec le fichier seul', s1.file?.id === f1.id && s1.file.name === 'Mon devoir été.pdf', s1);
  check('le même fichier ne peut pas servir deux fois (409/422)', [409, 422].includes((await submit(assign.id, tS, { fileId: f1.id })).status));
  check('l\'élève ne peut plus retirer un fichier rendu (409)', (await call('DELETE', `/files/${f1.id}`, tS)).status === 409);

  // ── Téléchargement et droits ──────────────────────────────────
  console.log('\nTéléchargement');
  const own = await download(f1.id, tS);
  check('l\'élève télécharge son fichier, identique octet pour octet', own.status === 200 && own.bytes.equals(PDF));
  check('toujours en pièce jointe, jamais affiché dans le navigateur', /^attachment;/.test(own.headers.get('content-disposition')) && own.headers.get('x-content-type-options') === 'nosniff' && own.headers.get('content-type') === 'application/pdf', Object.fromEntries(own.headers));
  check('nom accentué conservé dans l\'en-tête', decodeURIComponent(own.headers.get('content-disposition').split("UTF-8''")[1]) === 'Mon devoir été.pdf');
  check('pas de mise en cache', /no-store/.test(own.headers.get('cache-control')));
  check('sans connexion : 401', (await download(f1.id, null)).status === 401);
  check('un autre élève ne le voit pas (404)', (await download(f1.id, tOther)).status === 404);
  check('un élève étranger au cours non plus (404)', (await download(f1.id, tOutsider)).status === 404);
  check('un formateur non affecté non plus (404)', (await download(f1.id, tB)).status === 404);
  check('le formateur du cours le télécharge', (await download(f1.id, tI)).bytes.equals(PDF));
  check('l\'administrateur le télécharge', (await download(f1.id, tA)).status === 200);
  check('identifiant invalide : 404 et non 500', (await download('pas-un-uuid', tS)).status === 404);
  const draft = await download(sloppy.id, tI);
  check('un fichier pas encore rendu reste invisible du formateur (404)', draft.status === 404);
  check('… mais l\'élève le voit', (await download(sloppy.id, tS)).status === 200);

  // ── Correction ────────────────────────────────────────────────
  console.log('\nCorrection');
  const queue = must(await call('GET', '/studio/submissions', tI), 200, 'file');
  check('la file indique que la copie contient un fichier', queue.items.find((i) => i.id === s1.id)?.hasFile === true);
  const detail = must(await call('GET', `/studio/submissions/${s1.id}`, tI), 200, 'copie');
  check('le formateur voit le nom, le type et la taille du fichier', detail.file?.id === f1.id && detail.file.sizeBytes === PDF.length && !JSON.stringify(detail).includes('storageKey'), detail.file);
  must(await call('POST', `/studio/submissions/${s1.id}/grade`, tI, { decision: 'graded', scorePct: 80, feedback: 'Bon travail.' }), 200, 'correction');
  check('après correction, l\'élève télécharge toujours son fichier', (await download(f1.id, tS)).status === 200);

  // ── Retrait d'un brouillon, limite de fichiers en attente ─────
  console.log('\nBrouillons');
  const tD = await reg('Brouillon');
  must(await call('POST', `/courses/${course.id}/enroll`, tD, {}), 201, 'inscription 3');
  const drafts = [];
  for (let i = 0; i < 5; i++) drafts.push(must(await upload(assign.id, tD, PDF, `essai${i}.pdf`), 201, `brouillon ${i}`));
  check('5 fichiers en attente au plus (429 au sixième)', (await upload(assign.id, tD, PDF, 'sixieme.pdf')).status === 429);
  check('l\'élève retire un brouillon (204)', (await call('DELETE', `/files/${drafts[0].id}`, tD)).status === 204);
  check('… qui n\'est plus téléchargeable (404)', (await download(drafts[0].id, tD)).status === 404);
  check('un autre élève ne peut pas retirer ce brouillon (404)', (await call('DELETE', `/files/${drafts[1].id}`, tOther)).status === 404);
  check('une fois retiré, un nouvel envoi est possible', (await upload(assign.id, tD, PDF, 'nouveau.pdf')).status === 201);

  // ── Parent ────────────────────────────────────────────────────
  console.log('\nParent');
  const tP = await reg('Parent', { accountType: 'parent', birthDate: '1980-01-01' });
  const tP2 = await reg('Parent2', { accountType: 'parent', birthDate: '1980-01-01' });
  const username = `fic.enfant.${stamp}`;
  const child = must(await call('POST', '/parent/children', tP, { firstName: 'Petit', lastName: 'Test', birthDate: `${new Date().getFullYear() - 9}-01-01`, username, password: 'pin1234', relationship: 'mother' }), 201, 'enfant').child;
  must(await call('POST', `/courses/${course.id}/enroll`, tP, { forChildId: child.id }), 201, 'inscription enfant');
  const tC = await login(username, 'pin1234');
  const cf = must(await upload(assign.id, tC, PNG, 'dessin.png'), 201, 'envoi enfant');
  check('un parent ne peut pas voir un brouillon de son enfant (404)', (await download(cf.id, tP)).status === 404);
  must(await submit(assign.id, tC, { fileId: cf.id, content: 'Mon dessin' }), 201, 'remise enfant');
  const pc = await download(cf.id, tP);
  check('le parent télécharge le fichier rendu par son enfant', pc.status === 200 && pc.bytes.equals(PNG));
  const seen = must(await call('GET', `/parent/children/${child.id}/submissions`, tP), 200, 'copies enfant');
  check('la liste du parent indique le fichier', seen[0]?.file?.name === 'dessin.png', seen);
  check('un autre parent n\'y a pas accès (404)', (await download(cf.id, tP2)).status === 404);

  // ── Nettoyage ─────────────────────────────────────────────────
  await call('POST', `/studio/courses/${course.id}/publish`, tA, { published: false });
  for (const id of staff) await call('PATCH', `/admin/users/${id}`, tA, { isActive: false });
  console.log('\nFormation de test dépubliée, formateurs de test désactivés (leurs fichiers restent dans le dossier des envois).');
  console.log(failures ? `\n${failures} contrôle(s) en échec.` : '\nTous les contrôles sont passés.');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('\nERREUR :', e.message); process.exit(1); });
