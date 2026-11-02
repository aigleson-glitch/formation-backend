// Test de bout en bout : sujet de devoir téléversé par le formateur (envoi, remplacement, lien, téléchargement, droits).
//   node scripts/smoke-subject.mjs      (l'API tourne : npm run dev dans une autre fenêtre)
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
async function put(id, token, bytes, name) {
  const res = await fetch(`${API}/studio/assignments/${id}/subject`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', ...(token && { Authorization: `Bearer ${token}` }), ...(name !== undefined && { 'X-File-Name': encodeURIComponent(name) }) },
    body: bytes,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json };
}
async function get(id, token) {
  const res = await fetch(`${API}/assignments/${id}/subject`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
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


const PDF2 = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('second sujet '.repeat(30))]);

async function main() {
  console.log(`API : ${API}\n`);
  const tA = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const categories = must(await call('GET', '/categories'), 200, 'catégories');
  const categoryId = (Array.isArray(categories) ? categories : categories.categories)[0].id;
  const staff = [];
  const mkStaff = async (label) => {
    const u = must(await call('POST', '/admin/users', tA, { role: 'instructor', email: `suj.${label}.${stamp}@example.com`, password: PW, firstName: 'Test', lastName: label, canTeachMinors: true }), 201, label);
    staff.push(u.id);
    return u;
  };
  const tI = await login((await mkStaff('formateurA')).email);
  const tB = await login((await mkStaff('formateurB')).email);

  const course = must(await call('POST', '/studio/courses', tI, { categoryId, title: `[TEST] Sujet ${stamp}`, audiences: ['adult'] }), 201, 'cours');
  const m = must(await call('POST', `/studio/courses/${course.id}/modules`, tI, { title: 'Module' }), 201, 'module');
  const c = must(await call('POST', `/studio/modules/${m.id}/chapters`, tI, { title: 'Chapitre' }), 201, 'chapitre');
  must(await call('POST', `/studio/chapters/${c.id}/lessons`, tI, { title: 'Leçon', content: 'Texte' }), 201, 'leçon');
  const a = must(await call('POST', `/studio/modules/${m.id}/assignments`, tI, { title: 'Devoir avec sujet' }), 201, 'devoir');
  must(await call('POST', `/studio/courses/${course.id}/publish`, tI, { published: true }), 200, 'publication');
  const reg = async (label) => must(await call('POST', '/auth/register', null, { accountType: 'adult', email: `suj.${label}.${stamp}@example.com`, password: PW, firstName: 'Eleve', lastName: label, birthDate: '1990-01-01' }), 201, label).token;
  const tS = await reg('Inscrit');
  const tOut = await reg('Hors');
  must(await call('POST', `/courses/${course.id}/enroll`, tS, {}), 201, 'inscription');

  console.log('Envoi du sujet');
  check('sans connexion : 401', (await put(a.id, null, PDF, 'sujet.pdf')).status === 401);
  check('un élève ne peut pas envoyer (403)', (await put(a.id, tS, PDF, 'sujet.pdf')).status === 403);
  check('un autre formateur ne peut pas envoyer (403/404)', [403, 404].includes((await put(a.id, tB, PDF, 'sujet.pdf')).status));
  check('devoir inconnu : 404', (await put('pas-un-uuid', tI, PDF, 'sujet.pdf')).status === 404);
  check('faux PDF refusé (415)', (await put(a.id, tI, Buffer.from('<script>1</script>'), 'faux.pdf')).status === 415);
  check('fichier vide refusé (422)', (await put(a.id, tI, Buffer.alloc(0), 'vide.pdf')).status === 422);
  check('exécutable refusé (415)', (await put(a.id, tI, PDF, 'virus.exe')).status === 415);
  const noFile = await get(a.id, tI);
  check('aucun fichier avant l\'envoi (404)', noFile.status === 404);

  const up = must(await put(a.id, tI, PDF, 'Sujet été.pdf'), 201, 'envoi du sujet');
  check('sujet accepté : nom et taille renvoyés', up.name === 'Sujet été.pdf' && up.size === PDF.length, up);

  console.log('\nTéléchargement');
  const mine = await get(a.id, tI);
  check('le formateur le télécharge, contenu identique', mine.status === 200 && mine.bytes.equals(PDF));
  check('en pièce jointe, sans interprétation du type', /attachment/.test(mine.headers.get('content-disposition') ?? '') && mine.headers.get('x-content-type-options') === 'nosniff');
  const stu = await get(a.id, tS);
  check('l\'élève inscrit le télécharge', stu.status === 200 && stu.bytes.equals(PDF));
  check('un élève non inscrit : refusé (403)', (await get(a.id, tOut)).status === 403);
  check('un autre formateur : refusé (403/404)', [403, 404].includes((await get(a.id, tB)).status));
  check('sans connexion : 401', (await get(a.id, null)).status === 401);
  const view = must(await call('GET', `/assignments/${a.id}`, tS), 200, 'devoir élève');
  check('la fiche du devoir indique un fichier, sans clé de stockage', view.attachment?.file === true && view.attachment.name === 'Sujet été.pdf' && !JSON.stringify(view).includes('attachmentKey'), view.attachment);

  console.log('\nRemplacement, lien, retrait');
  must(await put(a.id, tI, PDF2, 'Version 2.pdf'), 201, 'remplacement');
  const v2 = await get(a.id, tS);
  check('le nouveau fichier remplace l\'ancien', v2.status === 200 && v2.bytes.equals(PDF2));
  const url = 'https://example.com/sujet.pdf';
  must(await call('PATCH', `/studio/assignments/${a.id}`, tI, { attachmentUrl: url, attachmentName: 'Lien' }), 200, 'passage au lien');
  check('un lien remplace le fichier (404 au téléchargement)', (await get(a.id, tS)).status === 404);
  const view2 = must(await call('GET', `/assignments/${a.id}`, tS), 200, 'devoir élève');
  check('la fiche expose le lien', view2.attachment?.url === url && !view2.attachment.file, view2.attachment);
  must(await put(a.id, tI, PDF, 'Retour.pdf'), 201, 'nouvel envoi');
  const view3 = must(await call('GET', `/assignments/${a.id}`, tS), 200, 'devoir élève');
  check('un fichier remplace le lien', view3.attachment?.file === true && !view3.attachment.url, view3.attachment);
  check('retrait : 204', (await call('DELETE', `/studio/assignments/${a.id}/subject`, tI)).status === 204);
  check('après retrait : plus de fichier (404)', (await get(a.id, tS)).status === 404);
  const view4 = must(await call('GET', `/assignments/${a.id}`, tS), 200, 'devoir élève');
  check('après retrait : plus de pièce jointe', view4.attachment === null, view4.attachment);

  await call('POST', `/studio/courses/${course.id}/publish`, tA, { published: false });
  for (const id of staff) await call('PATCH', `/admin/users/${id}`, tA, { isActive: false });
  console.log('\nFormation de test dépubliée, formateurs de test désactivés.');
  console.log(failures ? `\n${failures} contrôle(s) en échec.` : '\nTous les contrôles sont passés.');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('\nERREUR :', e.message); process.exit(1); });
