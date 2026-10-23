// Test de bout en bout de la phase 3 : devoirs (remise, correction, resoumission, déblocage, fin de formation, parent).
//   node scripts/smoke-assignments.mjs      (l'API tourne : npm run dev dans une autre fenêtre)
// Crée des comptes et une formation « [TEST] ... » (dépubliée / désactivés à la fin).
// Variables facultatives : API_URL, ADMIN_EMAIL, ADMIN_PASSWORD.
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
  const staff = [];

  // ── Mise en place : formateurs, formation (adultes + enfants), élèves, parent ──
  const mkStaff = async (label, canTeachMinors) => {
    const u = must(await call('POST', '/admin/users', tA, { role: 'instructor', email: `dev.${label}.${stamp}@example.com`, password: PW, firstName: 'Test', lastName: label, canTeachMinors }), 201, label);
    staff.push(u.id);
    return u;
  };
  const instrA = await mkStaff('formateurA', true);
  const instrB = await mkStaff('formateurB', true);
  const tI = await login(instrA.email);
  const tB = await login(instrB.email);

  const course = must(await call('POST', '/studio/courses', tI, { categoryId, title: `[TEST] Devoirs ${stamp}`, audiences: ['adult', 'child'], sequentialUnlock: true }), 201, 'cours');
  const lessons = [];
  const modules = [];
  for (const n of [1, 2]) {
    const m = must(await call('POST', `/studio/courses/${course.id}/modules`, tI, { title: `Module ${n}` }), 201, 'module');
    const c = must(await call('POST', `/studio/modules/${m.id}/chapters`, tI, { title: `Chapitre ${n}` }), 201, 'chapitre');
    lessons.push(must(await call('POST', `/studio/chapters/${c.id}/lessons`, tI, { title: `Leçon ${n}`, content: `Texte ${n}` }), 201, 'leçon'));
    modules.push(m);
  }
  const mkAssign = (body) => call('POST', `/studio/modules/${modules[0].id}/assignments`, tI, body);
  check('devoir sans titre refusé (400)', (await mkAssign({ title: '' })).status === 400);
  const tIntrus = must(await call('POST', '/auth/register', null, { accountType: 'adult', email: `dev.intrus.${stamp}@example.com`, password: PW, firstName: 'In', lastName: 'Trus', birthDate: '1990-01-01' }), 201, 'intrus').token;
  check('un élève ne crée pas de devoir (403)', (await call('POST', `/studio/modules/${modules[0].id}/assignments`, tIntrus, { title: 'Pirate' })).status === 403);
  const assign = must(await mkAssign({ title: 'Mon premier projet', instructions: 'Décris ton projet en 10 lignes.', passMark: 70, maxAttempts: 2 }), 201, 'devoir');
  check('devoir créé, obligatoire par défaut', assign.type === 'assignment' && assign.isRequired === true && assign.maxAttempts === 2);
  must(await call('POST', `/studio/courses/${course.id}/publish`, tI, { published: true }), 200, 'publication');
  check('la formation avec un devoir (sans question) se publie', true);

  const reg = async (label) => must(await call('POST', '/auth/register', null, { accountType: 'adult', email: `dev.${label}.${stamp}@example.com`, password: PW, firstName: 'Eleve', lastName: label, birthDate: '1990-01-01' }), 201, label).token;
  const tS = await reg('eleve');
  const tOther = await reg('autre');
  const enr = must(await call('POST', `/courses/${course.id}/enroll`, tS, {}), 201, 'inscription').enrollment;

  const lessonOfModule2 = async (t) => (await call('GET', `/lessons/${lessons[1].id}`, t)).status;

  // ── Remise par l'élève ────────────────────────────────────────
  console.log('Remise du devoir');
  check('module 2 verrouillé tant que le devoir n\'est pas réussi (403)', (await lessonOfModule2(tS)) === 403);
  const view0 = must(await call('GET', `/assignments/${assign.id}`, tS), 200, 'fiche');
  check('fiche : 2 tentatives, remise possible, aucune copie', view0.canSubmit === true && view0.attemptsLeft === 2 && view0.submissions.length === 0);
  check('un élève non inscrit n\'accède pas au devoir (403)', (await call('GET', `/assignments/${assign.id}`, tOther)).status === 403);
  check('sans connexion : 401', (await call('GET', `/assignments/${assign.id}`)).status === 401);
  check('identifiant invalide : 404 et non 500', (await call('GET', '/assignments/pas-un-uuid', tS)).status === 404);
  check('remise vide refusée (422)', (await call('POST', `/assignments/${assign.id}/submissions`, tS, {})).status === 422);
  check('lien http refusé (422)', (await call('POST', `/assignments/${assign.id}/submissions`, tS, { linkUrl: 'http://exemple.com' })).status === 422);
  check('lien javascript: refusé (422)', (await call('POST', `/assignments/${assign.id}/submissions`, tS, { linkUrl: 'javascript:alert(1)' })).status === 422);
  const s1 = must(await call('POST', `/assignments/${assign.id}/submissions`, tS, { content: 'Mon projet : un site de recettes.', linkUrl: 'https://github.com/eleve/recettes' }), 201, 'remise 1');
  check('remise enregistrée en attente, sans note visible', s1.status === 'submitted' && s1.attemptNo === 1 && s1.scorePct === undefined && s1.feedback === undefined);
  check('seconde remise refusée tant que la première n\'est pas corrigée (409)', (await call('POST', `/assignments/${assign.id}/submissions`, tS, { content: 'bis' })).status === 409);
  check('un autre élève ne peut pas rendre ce devoir (403)', (await call('POST', `/assignments/${assign.id}/submissions`, tOther, { content: 'x' })).status === 403);

  // ── File de correction ────────────────────────────────────────
  console.log('\nCorrection par le formateur');
  const queue = must(await call('GET', '/studio/submissions', tI), 200, 'file');
  check('la copie apparaît dans la file du formateur', queue.items.some((i) => i.id === s1.id && i.student.firstName === 'Eleve' && i.assignment.id === assign.id));
  const queueB = must(await call('GET', '/studio/submissions', tB), 200, 'file B');
  check('un formateur non affecté ne voit pas la copie', !queueB.items.some((i) => i.id === s1.id));
  check('… et ne peut pas l\'ouvrir (403)', (await call('GET', `/studio/submissions/${s1.id}`, tB)).status === 403);
  check('… ni la corriger (403)', (await call('POST', `/studio/submissions/${s1.id}/grade`, tB, { decision: 'graded', scorePct: 100, feedback: 'ok' })).status === 403);
  check('un élève n\'accède pas à la file (403)', (await call('GET', '/studio/submissions', tS)).status === 403);
  const full = must(await call('GET', `/studio/submissions/${s1.id}`, tI), 200, 'copie');
  check('le formateur lit le texte, le lien et le seuil', full.content.includes('recettes') && full.linkUrl.startsWith('https://github.com') && full.assignment.passMark === 70);
  const rev = must(await call('POST', `/studio/submissions/${s1.id}/start-review`, tI), 200, 'prise en charge');
  check('copie prise en charge : « En correction »', rev.status === 'in_review' && rev.graderId === instrA.id);
  check('l\'élève voit « en correction » sans note', (await call('GET', `/assignments/${assign.id}`, tS)).json.submissions[0].status === 'in_review');

  check('correction sans commentaire refusée (422)', (await call('POST', `/studio/submissions/${s1.id}/grade`, tI, { decision: 'graded', scorePct: 50 })).status === 422);
  check('correction sans note refusée (422)', (await call('POST', `/studio/submissions/${s1.id}/grade`, tI, { decision: 'graded', feedback: 'bien' })).status === 422);
  check('note supérieure à 100 refusée (400)', (await call('POST', `/studio/submissions/${s1.id}/grade`, tI, { decision: 'graded', scorePct: 101, feedback: 'x' })).status === 400);
  const g1 = must(await call('POST', `/studio/submissions/${s1.id}/grade`, tI, { decision: 'graded', scorePct: 50, feedback: 'Il manque la conclusion.' }), 200, 'correction 1');
  check('50 % : corrigé, non réussi', g1.status === 'graded' && g1.passed === false && g1.scorePct === 50);
  const v1 = must(await call('GET', `/assignments/${assign.id}`, tS), 200, 'fiche');
  check('l\'élève voit sa note et le commentaire', v1.submissions[0].scorePct === 50 && v1.submissions[0].feedback.includes('conclusion'));
  check('il lui reste une tentative', v1.canSubmit === true && v1.attemptsLeft === 1);
  check('module 2 toujours verrouillé après un échec (403)', (await lessonOfModule2(tS)) === 403);

  // ── Resoumission demandée, puis réussite ───────────────────────
  console.log('\nResoumission et réussite');
  const s2 = must(await call('POST', `/assignments/${assign.id}/submissions`, tS, { content: 'Version 2 incomplète' }), 201, 'remise 2');
  check('2e remise : tentative n° 2', s2.attemptNo === 2);
  const g2 = must(await call('POST', `/studio/submissions/${s2.id}/grade`, tI, { decision: 'resubmit', feedback: 'Refaites la partie 2, puis renvoyez.' }), 200, 'à resoumettre');
  check('« à resoumettre » : non réussi, sans note', g2.status === 'resubmit' && g2.passed === false && g2.scorePct === null);
  const v2 = must(await call('GET', `/assignments/${assign.id}`, tS), 200, 'fiche');
  check('« à resoumettre » ne consomme pas la dernière tentative', v2.canSubmit === true && v2.attemptsLeft === 1);
  const s3 = must(await call('POST', `/assignments/${assign.id}/submissions`, tS, { content: 'Version 3 complète' }), 201, 'remise 3');
  check('3e copie : tentative n° 3', s3.attemptNo === 3);
  check('l\'ancienne copie « à resoumettre » ne peut plus être corrigée (409)', (await call('POST', `/studio/submissions/${s2.id}/grade`, tI, { decision: 'graded', scorePct: 90, feedback: 'x' })).status === 409);
  check('l\'ancienne copie corrigée n° 1 ne peut plus être révisée (409)', (await call('POST', `/studio/submissions/${s1.id}/grade`, tI, { decision: 'graded', scorePct: 90, feedback: 'x' })).status === 409);
  const g3 = must(await call('POST', `/studio/submissions/${s3.id}/grade`, tI, { decision: 'graded', scorePct: 85, feedback: 'Très bien.' }), 200, 'correction 3');
  check('85 % : réussi', g3.status === 'graded' && g3.passed === true);
  check('le module 2 se débloque après la réussite (200)', (await lessonOfModule2(tS)) === 200);
  const v3 = must(await call('GET', `/assignments/${assign.id}`, tS), 200, 'fiche');
  check('devoir réussi : plus de remise possible', v3.canSubmit === false && /réussi/.test(v3.reason));
  check('remise après réussite refusée (409)', (await call('POST', `/assignments/${assign.id}/submissions`, tS, { content: 'encore' })).status === 409);

  // ── Révision d'une note ────────────────────────────────────────
  const reg3 = must(await call('POST', `/studio/submissions/${s3.id}/grade`, tI, { decision: 'graded', scorePct: 40, feedback: 'Après relecture, note abaissée.' }), 200, 'révision');
  check('note révisée à 40 % : plus réussi', reg3.passed === false);
  check('… et le module 2 se reverrouille (403)', (await lessonOfModule2(tS)) === 403);
  must(await call('POST', `/studio/submissions/${s3.id}/grade`, tI, { decision: 'graded', scorePct: 90, feedback: 'Finalement correct.' }), 200, 'révision 2');
  check('note remontée à 90 % : le module 2 se rouvre (200)', (await lessonOfModule2(tS)) === 200);

  // ── Fin de formation ───────────────────────────────────────────
  console.log('\nFin de formation');
  for (const l of lessons) must(await call('POST', `/lessons/${l.id}/complete`, tS, {}), 200, 'leçon terminée');
  const mine = must(await call('GET', '/my/enrollments', tS), 200, 'inscriptions').find((e) => e.id === enr.id);
  check('leçons terminées + devoir réussi → formation terminée', mine.status === 'completed' && mine.progressPct === 100, mine);

  // ── Intégrité côté formateur ───────────────────────────────────
  console.log('\nIntégrité');
  check('un devoir rendu ne se supprime pas par la route des quiz (400)', (await call('DELETE', `/studio/assessments/${assign.id}`, tI)).status === 400);
  check('… ni par la route des devoirs (409)', (await call('DELETE', `/studio/assignments/${assign.id}`, tI)).status === 409);
  check('le seuil ne change plus après une remise (409)', (await call('PATCH', `/studio/assignments/${assign.id}`, tI, { passMark: 50 })).status === 409);
  check('les consignes restent corrigeables (200)', (await call('PATCH', `/studio/assignments/${assign.id}`, tI, { instructions: 'Consigne précisée.' })).status === 200);
  const info = must(await call('GET', `/studio/assignments/${assign.id}`, tI), 200, 'fiche formateur');
  check('fiche formateur : 3 copies, aucune à corriger, devoir figé', info.submissionsCount === 3 && info.toGrade === 0 && info.locked === true);
  const spare = must(await mkAssign({ title: 'Devoir facultatif', isRequired: false }), 201, 'devoir 2');
  check('un devoir sans copie se supprime (204)', (await call('DELETE', `/studio/assignments/${spare.id}`, tI)).status === 204);
  const old = must(await call('GET', '/studio/submissions?status=graded', tI), 200, 'historique');
  check('l\'historique des copies corrigées est consultable', old.items.some((i) => i.id === s1.id));

  // ── Parent : lecture seule ─────────────────────────────────────
  console.log('\nParent');
  const tP = must(await call('POST', '/auth/register', null, { accountType: 'parent', email: `dev.parent.${stamp}@example.com`, password: PW, firstName: 'Parent', lastName: 'Test', birthDate: '1980-01-01' }), 201, 'parent').token;
  const tP2 = must(await call('POST', '/auth/register', null, { accountType: 'parent', email: `dev.parent2.${stamp}@example.com`, password: PW, firstName: 'Autre', lastName: 'Parent', birthDate: '1980-01-01' }), 201, 'parent 2').token;
  const username = `dev.enfant.${stamp}`;
  const child = must(await call('POST', '/parent/children', tP, { firstName: 'Petit', lastName: 'Test', birthDate: `${new Date().getFullYear() - 9}-01-01`, username, password: 'pin1234', relationship: 'mother' }), 201, 'enfant').child;
  must(await call('POST', `/courses/${course.id}/enroll`, tP, { forChildId: child.id }), 201, 'inscription de l\'enfant');
  const tC = await login(username, 'pin1234');
  const cs = must(await call('POST', `/assignments/${assign.id}/submissions`, tC, { content: 'Mon dessin du projet.' }), 201, 'remise de l\'enfant');
  const seen = must(await call('GET', `/parent/children/${child.id}/submissions`, tP), 200, 'copies de l\'enfant');
  check('le parent voit la copie de son enfant, en attente', seen.length === 1 && seen[0].status === 'submitted' && seen[0].content.includes('dessin') && seen[0].scorePct === undefined);
  check('un autre parent n\'a pas accès (403)', (await call('GET', `/parent/children/${child.id}/submissions`, tP2)).status === 403);
  check('le parent ne peut pas rendre un devoir à la place de l\'enfant (403)', (await call('POST', `/assignments/${assign.id}/submissions`, tP, { content: 'x' })).status === 403);
  must(await call('POST', `/studio/submissions/${cs.id}/grade`, tI, { decision: 'graded', scorePct: 75, feedback: 'Joli dessin !' }), 200, 'correction enfant');
  const seen2 = must(await call('GET', `/parent/children/${child.id}/submissions`, tP), 200, 'copies de l\'enfant');
  check('après correction, le parent voit la note et le commentaire', seen2[0].scorePct === 75 && seen2[0].feedback === 'Joli dessin !');

  // ── Envois et corrections simultanés ───────────────────────────
  console.log('\nSimultanéité');
  const tR = await reg('course');
  must(await call('POST', `/courses/${course.id}/enroll`, tR, {}), 201, 'inscription');
  const twice = await Promise.all([1, 2].map((n) => call('POST', `/assignments/${assign.id}/submissions`, tR, { content: `double clic ${n}` })));
  check('double envoi : une seule copie enregistrée (201 + 409)', twice.map((r) => r.status).sort().join() === '201,409', twice.map((r) => r.status));
  const rid = twice.find((r) => r.status === 201).json.id;
  const dual = await Promise.all([60, 90].map((score) => call('POST', `/studio/submissions/${rid}/grade`, tI, { decision: 'graded', scorePct: score, feedback: `note ${score}` })));
  check('deux corrections simultanées : une seule est enregistrée (200 + 409)', dual.map((r) => r.status).sort().join() === '200,409', dual.map((r) => r.status));

  // ── Nettoyage ──────────────────────────────────────────────────
  await call('POST', `/studio/courses/${course.id}/publish`, tA, { published: false });
  for (const id of staff) await call('PATCH', `/admin/users/${id}`, tA, { isActive: false });
  console.log('\nFormation de test dépubliée, formateurs de test désactivés (ils restent en base).');
  console.log(failures ? `\n${failures} contrôle(s) en échec.` : '\nTous les contrôles sont passés.');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('\nERREUR :', e.message); process.exit(1); });
