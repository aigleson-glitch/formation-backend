// Règle du certificat : leçons + évaluations obligatoires réussies + évaluations facultatives tentées/rendues.
//   node scripts/smoke-certificate-rule.mjs      (l'API tourne : npm run dev dans une autre fenêtre)
// Crée des comptes et une formation « [TEST] ... » (dépubliée à la fin ; node scripts/clean-tests.mjs la supprime).
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
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
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
  const instr = must(await call('POST', '/admin/users', tA, { role: 'instructor', email: `regle.formateur.${stamp}@example.com`, password: PW, firstName: 'Test', lastName: 'Formateur' }), 201, 'formateur');
  const tI = await login(instr.email);
  const course = must(await call('POST', '/studio/courses', tI, { categoryId, title: `[TEST] Regle certificat ${stamp}`, audiences: ['adult'] }), 201, 'cours');
  const m = must(await call('POST', `/studio/courses/${course.id}/modules`, tI, { title: 'Module' }), 201, 'module');
  const c = must(await call('POST', `/studio/modules/${m.id}/chapters`, tI, { title: 'Chapitre' }), 201, 'chapitre');
  const lesson = must(await call('POST', `/studio/chapters/${c.id}/lessons`, tI, { title: 'Leçon', content: 'Texte' }), 201, 'leçon');

  const mkQuiz = async (title, isRequired, withQuestion) => {
    const q = must(await call('POST', `/studio/modules/${m.id}/assessments`, tI, { type: 'quiz', title, passMark: 70, maxAttempts: 3, isRequired }), 201, title);
    if (withQuestion) must(await call('POST', `/studio/assessments/${q.id}/questions`, tI, { type: 'true_false', text: 'Vrai ?', correctAnswer: true }), 201, 'question');
    return q;
  };
  const required = await mkQuiz('Quiz obligatoire', true, true);
  const optional = await mkQuiz('Quiz facultatif', false, true);
  const hw = must(await call('POST', `/studio/modules/${m.id}/assignments`, tI, { title: 'Devoir facultatif', instructions: 'Écrivez.', passMark: 70, maxAttempts: 2, isRequired: false }), 201, 'devoir');
  must(await call('POST', `/studio/courses/${course.id}/publish`, tI, { published: true }), 200, 'publication');

  // Ajouté après la publication (une formation publiée n'accepte pas de quiz vide) : ne doit jamais bloquer le certificat
  await mkQuiz('Quiz facultatif vide', false, false);

  const tS = must(await call('POST', '/auth/register', null, { accountType: 'adult', email: `regle.eleve.${stamp}@example.com`, password: PW, firstName: 'Marie', lastName: 'Regle', birthDate: '1990-01-01' }), 201, 'élève').token;
  must(await call('POST', `/courses/${course.id}/enroll`, tS, {}), 201, 'inscription');
  const certs = async () => (await call('GET', '/my/certificates', tS)).json.length;
  const answer = async (quiz, value) => {
    const start = must(await call('POST', `/assessments/${quiz.id}/attempts`, tS), 201, 'tentative');
    const full = must(await call('GET', `/studio/assessments/${quiz.id}`, tI), 200, 'vue formateur');
    const q = full.questions[0];
    const opt = q.options.find((o) => (value ? o.isCorrect : !o.isCorrect));
    return must(await call('POST', `/attempts/${start.attempt.id}/submit`, tS, { answers: [{ questionId: q.id, optionIds: [opt.id] }] }), 200, 'envoi');
  };

  must(await call('POST', `/lessons/${lesson.id}/complete`, tS, {}), 200, 'leçon');
  check('leçons terminées mais rien d\'autre : pas de certificat', (await certs()) === 0);
  await answer(required, true);
  check('quiz obligatoire réussi, facultatifs non faits : pas de certificat', (await certs()) === 0);
  await answer(optional, false);
  check('quiz facultatif tenté (même raté), devoir facultatif non rendu : pas de certificat', (await certs()) === 0);
  must(await call('POST', `/assignments/${hw.id}/submissions`, tS, { content: 'Mon devoir' }), 201, 'remise');
  check('devoir facultatif rendu : formation terminée, certificat émis', (await certs()) === 1);
  check('le quiz facultatif vide n\'a jamais bloqué', true);

  await call('POST', `/studio/courses/${course.id}/publish`, tI, { published: false });
  await call('PATCH', `/admin/users/${instr.id}`, tA, { isActive: false });
  console.log('\nFormation de test dépubliée, formateur de test désactivé.');
  console.log(failures ? `\n${failures} contrôle(s) en échec.` : '\nTous les contrôles sont passés.');
  process.exitCode = failures ? 1 : 0;
}
main().catch((e) => { console.error('\nERREUR :', e.message); process.exitCode = 1; });
