// Test de bout en bout : émission automatique des certificats, consultation, vérification publique, parent.
//   node scripts/smoke-certificates.mjs      (l'API tourne : npm run dev dans une autre fenêtre)
// Crée des comptes et une formation « [TEST] ... » (dépubliée / désactivés à la fin).
const API = process.env.API_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'ChangeMe123!';
const stamp = Date.now();
const PW = 'MotDePasseTest-2026';
const CODE = /^CERT-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;

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
const must = (r, expected, what) => {
  if (r.status !== expected) throw new Error(`${what} : statut ${r.status} (attendu ${expected}) ${JSON.stringify(r.json)}`);
  return r.json;
};
const login = async (identifier, password = PW) => must(await call('POST', '/auth/login', null, { identifier, password }), 200, `connexion ${identifier}`).token;

async function main() {
  console.log(`API : ${API}\n`);
  const tA = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const categories = must(await call('GET', '/categories'), 200, 'catégories');
  const categoryId = (Array.isArray(categories) ? categories : categories.categories)[0].id;

  // Formation : 1 module, 2 leçons, adultes + enfants
  const instr = must(await call('POST', '/admin/users', tA, { role: 'instructor', email: `cert.formateur.${stamp}@example.com`, password: PW, firstName: 'Test', lastName: 'Formateur', canTeachMinors: true }), 201, 'formateur');
  const tI = await login(instr.email);
  const course = must(await call('POST', '/studio/courses', tI, { categoryId, title: `[TEST] Certificats ${stamp}`, audiences: ['adult', 'child'] }), 201, 'cours');
  const m = must(await call('POST', `/studio/courses/${course.id}/modules`, tI, { title: 'Module' }), 201, 'module');
  const c = must(await call('POST', `/studio/modules/${m.id}/chapters`, tI, { title: 'Chapitre' }), 201, 'chapitre');
  const lessons = [];
  for (const n of [1, 2]) lessons.push(must(await call('POST', `/studio/chapters/${c.id}/lessons`, tI, { title: `Leçon ${n}`, content: `Texte ${n}` }), 201, 'leçon'));
  must(await call('POST', `/studio/courses/${course.id}/publish`, tI, { published: true }), 200, 'publication');

  const reg = async (label, extra = {}) => must(await call('POST', '/auth/register', null, { accountType: 'adult', email: `cert.${label}.${stamp}@example.com`, password: PW, firstName: 'Marie', lastName: label, birthDate: '1990-01-01', ...extra }), 201, label).token;

  // ── Adulte ────────────────────────────────────────────────────
  console.log('Adulte');
  const tS = await reg('Ngoma');
  const tOther = await reg('Autre');
  must(await call('POST', `/courses/${course.id}/enroll`, tS, {}), 201, 'inscription');
  must(await call('POST', `/courses/${course.id}/enroll`, tOther, {}), 201, 'inscription 2');
  check('aucun certificat avant la fin de la formation', (await call('GET', '/my/certificates', tS)).json.length === 0);
  must(await call('POST', `/lessons/${lessons[0].id}/complete`, tS, {}), 200, 'leçon 1');
  check('… ni après une seule leçon sur deux', (await call('GET', '/my/certificates', tS)).json.length === 0);
  must(await call('POST', `/lessons/${lessons[1].id}/complete`, tS, {}), 200, 'leçon 2');
  const mine = must(await call('GET', '/my/certificates', tS), 200, 'certificats');
  check('la dernière leçon termine la formation et émet un certificat', mine.length === 1 && CODE.test(mine[0].code), mine);
  const cert = mine[0];
  check('le certificat porte le nom, la formation, la date et le lien de vérification', cert.holder.firstName === 'Marie' && cert.holder.lastName === 'Ngoma' && cert.course.title.includes('Certificats') && !!cert.issuedAt && cert.verifyPath === `/certificates/verify/${cert.code}`, cert);
  check('terminer à nouveau une leçon ne crée pas de second certificat', (await call('POST', `/lessons/${lessons[1].id}/complete`, tS, {})).status === 200 && (await call('GET', '/my/certificates', tS)).json.length === 1);
  const enr = (await call('GET', '/my/enrollments', tS)).json[0];
  check('« Mes cours » indique le code du certificat', enr.certificate?.code === cert.code, enr.certificate);
  check('fiche du certificat consultable par son titulaire', (await call('GET', `/my/certificates/${cert.code}`, tS)).json.code === cert.code);
  check('un autre élève ne voit pas ce certificat (404)', (await call('GET', `/my/certificates/${cert.code}`, tOther)).status === 404);
  check('sans connexion : 401', (await call('GET', '/my/certificates')).status === 401);
  check('l\'autre élève, qui n\'a rien terminé, n\'a aucun certificat', (await call('GET', '/my/certificates', tOther)).json.length === 0);

  console.log('\nVérification publique');
  const pub = await call('GET', `/certificates/verify/${cert.code}`);
  check('le code se vérifie sans connexion', pub.status === 200 && pub.json.valid === true && pub.json.course.includes('Certificats'), pub);
  check('adulte : nom complet affiché', pub.json.holder === 'Marie Ngoma', pub.json.holder);
  check('aucune donnée personnelle superflue (e-mail, identifiant, date de naissance)', !/@|birth|email|userId|enrollment/i.test(JSON.stringify(pub.json)), pub.json);
  const sloppy = cert.code.toLowerCase().replaceAll('-', ' ');
  check('saisie tolérante (minuscules, espaces)', (await call('GET', `/certificates/verify/${encodeURIComponent(sloppy)}`)).json.valid === true);
  const unknown = await call('GET', '/certificates/verify/CERT-AAAA-BBBB-CCCC');
  check('code inconnu : 404 et valid=false', unknown.status === 404 && unknown.json.valid === false, unknown);
  check('code mal formé : 404 et non 500', (await call('GET', '/certificates/verify/pas-un-code')).status === 404);
  check('tentative d\'injection de chemin : 404', (await call('GET', '/certificates/verify/..%2F..%2Fetc')).status === 404);

  // ── Enfant et parent ──────────────────────────────────────────
  console.log('\nEnfant et parent');
  const tP = await reg('Parent', { accountType: 'parent', birthDate: '1980-01-01' });
  const tP2 = await reg('Parent2', { accountType: 'parent', birthDate: '1980-01-01' });
  const username = `cert.enfant.${stamp}`;
  const child = must(await call('POST', '/parent/children', tP, { firstName: 'Petit', lastName: 'Mbemba', birthDate: `${new Date().getFullYear() - 9}-01-01`, username, password: 'pin1234', relationship: 'mother' }), 201, 'enfant').child;
  must(await call('POST', `/courses/${course.id}/enroll`, tP, { forChildId: child.id }), 201, 'inscription enfant');
  const tC = await login(username, 'pin1234');
  for (const l of lessons) must(await call('POST', `/lessons/${l.id}/complete`, tC, {}), 200, 'leçon enfant');
  const childCerts = must(await call('GET', `/parent/children/${child.id}/certificates`, tP), 200, 'certificats de l\'enfant');
  check('le parent voit le certificat de son enfant', childCerts.length === 1 && CODE.test(childCerts[0].code), childCerts);
  check('un autre parent n\'y a pas accès (403)', (await call('GET', `/parent/children/${child.id}/certificates`, tP2)).status === 403);
  check('l\'enfant voit son propre certificat', (await call('GET', '/my/certificates', tC)).json.length === 1);
  const pubChild = await call('GET', `/certificates/verify/${childCerts[0].code}`);
  check('enfant : prénom et initiale seulement sur la page publique', pubChild.json.holder === 'Petit M.', pubChild.json.holder);

  // ── Nettoyage ─────────────────────────────────────────────────
  await call('POST', `/studio/courses/${course.id}/publish`, tA, { published: false });
  await call('PATCH', `/admin/users/${instr.id}`, tA, { isActive: false });
  console.log('\nFormation de test dépubliée, formateur de test désactivé (ils restent en base).');
  console.log(failures ? `\n${failures} contrôle(s) en échec.` : '\nTous les contrôles sont passés.');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('\nERREUR :', e.message); process.exit(1); });
