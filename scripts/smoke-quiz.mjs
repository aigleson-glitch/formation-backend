// Test de bout en bout des quiz contre l'API en marche (npm run dev dans une autre fenêtre) :
//   node scripts/smoke-quiz.mjs
// Crée une formation de test « [TEST] ... » (dépubliée à la fin) et deux apprenants de test.
// Variables facultatives : API_URL, INSTRUCTOR_EMAIL, INSTRUCTOR_PASSWORD.

const API = process.env.API_URL ?? 'http://localhost:3000';
const INSTRUCTOR_EMAIL = process.env.INSTRUCTOR_EMAIL ?? 'formateur@example.com';
const INSTRUCTOR_PASSWORD = process.env.INSTRUCTOR_PASSWORD ?? 'ChangeMe123!';
const stamp = Date.now();

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  OK  ' : ' ECHEC'}  ${label}${ok ? '' : detail ? `  →  ${detail}` : ''}`);
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
  return { status: res.status, json, text };
}
const must = (r, expected, what) => {
  if (r.status !== expected) throw new Error(`${what} : statut ${r.status} (attendu ${expected}) ${JSON.stringify(r.json)}`);
  return r.json;
};

async function register(label) {
  const r = await call('POST', '/auth/register', null, {
    accountType: 'adult', email: `smoke.${label}.${stamp}@example.com`, password: 'MotDePasseTest1',
    firstName: 'Test', lastName: label, birthDate: '1990-01-01',
  });
  return must(r, 201, `inscription ${label}`).token;
}

async function main() {
  console.log(`API : ${API}\n`);

  // ── Préparation par le formateur ──
  const tI = must(await call('POST', '/auth/login', null, { identifier: INSTRUCTOR_EMAIL, password: INSTRUCTOR_PASSWORD }), 200, 'connexion formateur').token;
  const categories = must(await call('GET', '/categories'), 200, 'catégories');
  const categoryId = (Array.isArray(categories) ? categories : categories.categories)[0].id;

  const course = must(await call('POST', '/studio/courses', tI, {
    categoryId, title: `[TEST] Quiz ${stamp}`, audiences: ['adult'], sequentialUnlock: true, language: 'fr',
  }), 201, 'création formation');

  const modules = [];
  for (const name of ['A', 'B']) {
    const m = must(await call('POST', `/studio/courses/${course.id}/modules`, tI, { title: `Module ${name}` }), 201, `module ${name}`);
    const ch = must(await call('POST', `/studio/modules/${m.id}/chapters`, tI, { title: `Chapitre ${name}` }), 201, `chapitre ${name}`);
    must(await call('POST', `/studio/chapters/${ch.id}/lessons`, tI, { title: `Leçon ${name}`, content: 'Contenu de test' }), 201, `leçon ${name}`);
    modules.push(m);
  }

  const quizA = must(await call('POST', `/studio/modules/${modules[0].id}/assessments`, tI, { type: 'quiz', title: 'Quiz A', passMark: 70, maxAttempts: 2 }), 201, 'quiz A');
  const quizB = must(await call('POST', `/studio/modules/${modules[1].id}/assessments`, tI, { type: 'quiz', title: 'Quiz B' }), 201, 'quiz B');

  console.log('Création des questions');
  const SECRET = 'EXPLICATION-SECRETE-123';
  const bad = await call('POST', `/studio/assessments/${quizA.id}/questions`, tI, {
    type: 'single', text: 'Invalide', options: [{ text: 'a', isCorrect: true }, { text: 'b', isCorrect: true }],
  });
  check('question à choix unique avec deux bonnes réponses refusée (422)', bad.status === 422, `statut ${bad.status}`);

  must(await call('POST', `/studio/assessments/${quizA.id}/questions`, tI, {
    type: 'single', text: 'Combien font 2 + 2 ?', explanation: SECRET, points: 1,
    options: [{ text: '3', isCorrect: false }, { text: '4', isCorrect: true }, { text: '5', isCorrect: false }],
  }), 201, 'question 1');
  must(await call('POST', `/studio/assessments/${quizA.id}/questions`, tI, {
    type: 'multiple', text: 'Quels nombres sont pairs ?', explanation: SECRET, points: 2,
    options: [{ text: '2', isCorrect: true }, { text: '3', isCorrect: false }, { text: '4', isCorrect: true }],
  }), 201, 'question 2');
  must(await call('POST', `/studio/assessments/${quizA.id}/questions`, tI, {
    type: 'true_false', text: 'Le soleil est une étoile.', explanation: SECRET, correctAnswer: true,
  }), 201, 'question 3');

  const emptyPublish = await call('POST', `/studio/courses/${course.id}/publish`, tI, { published: true });
  check('publication refusée tant qu\'un quiz est vide (422)', emptyPublish.status === 422, `statut ${emptyPublish.status}`);
  must(await call('POST', `/studio/assessments/${quizB.id}/questions`, tI, {
    type: 'true_false', text: 'Question du quiz B', correctAnswer: false,
  }), 201, 'question quiz B');
  must(await call('POST', `/studio/courses/${course.id}/publish`, tI, { published: true }), 200, 'publication');

  // Bonnes et mauvaises réponses d'après la vue du formateur
  const full = must(await call('GET', `/studio/assessments/${quizA.id}`, tI), 200, 'vue formateur');
  const right = full.questions.map((q) => ({ questionId: q.id, optionIds: q.options.filter((o) => o.isCorrect).map((o) => o.id) }));
  const wrong = full.questions.map((q) => ({ questionId: q.id, optionIds: [q.options.find((o) => !o.isCorrect).id] }));

  // ── Passage par l'élève ──
  console.log('\nParcours de l\'élève');
  const tL = await register('Eleve');
  must(await call('POST', `/courses/${course.id}/enroll`, tL, {}), 201, 'inscription à la formation');

  const lockedB = await call('GET', `/assessments/${quizB.id}`, tL);
  check('le quiz du module B est verrouillé au départ (403)', lockedB.status === 403, `statut ${lockedB.status}`);

  const sheet = must(await call('GET', `/assessments/${quizA.id}`, tL), 200, 'fiche du quiz');
  check('fiche : 2 tentatives disponibles, 3 questions', sheet.attemptsLeft === 2 && sheet.questionCount === 3, JSON.stringify(sheet));

  const start1 = await call('POST', `/assessments/${quizA.id}/attempts`, tL);
  check('démarrage d\'une tentative (201)', start1.status === 201, `statut ${start1.status}`);
  check('AUCUNE bonne réponse ni explication avant la soumission',
    !/isCorrect|explanation|EXPLICATION-SECRETE/.test(start1.text), 'fuite détectée dans les questions');
  const resume = await call('POST', `/assessments/${quizA.id}/attempts`, tL);
  check('un second démarrage reprend la même tentative (200)', resume.status === 200 && resume.json.attempt.id === start1.json.attempt.id);

  const attempt1 = start1.json.attempt.id;
  const bogus = await call('POST', `/attempts/${attempt1}/submit`, tL, { answers: [{ questionId: '00000000-0000-4000-8000-000000000000', optionIds: [] }] });
  check('réponse à une question étrangère refusée (400)', bogus.status === 400, `statut ${bogus.status}`);

  const res1 = await call('POST', `/attempts/${attempt1}/submit`, tL, { answers: wrong });
  check('tentative 1 (tout faux) : 0 %, non réussi', res1.status === 200 && res1.json.attempt.scorePct === 0 && res1.json.attempt.passed === false, JSON.stringify(res1.json?.attempt));
  check('module pas encore compétent, 1 tentative restante', res1.json?.moduleStatus === 'not_yet' && res1.json?.attemptsLeft === 1);
  check('la correction contient bonnes réponses et explications',
    res1.json?.questions?.every((q) => q.options.some((o) => o.isCorrect)) && res1.text.includes(SECRET));

  const twice = await call('POST', `/attempts/${attempt1}/submit`, tL, { answers: right });
  check('double soumission refusée (409)', twice.status === 409, `statut ${twice.status}`);
  check('le module B reste verrouillé après un échec', (await call('GET', `/assessments/${quizB.id}`, tL)).status === 403);

  const start2 = must(await call('POST', `/assessments/${quizA.id}/attempts`, tL), 201, 'tentative 2');
  const res2 = await call('POST', `/attempts/${start2.attempt.id}/submit`, tL, { answers: right });
  check('tentative 2 (tout juste) : 100 %, réussi', res2.status === 200 && res2.json.attempt.scorePct === 100 && res2.json.attempt.passed === true, JSON.stringify(res2.json?.attempt));
  check('module compétent, plus de tentatives', res2.json?.moduleStatus === 'competent' && res2.json?.attemptsLeft === 0);

  const third = await call('POST', `/assessments/${quizA.id}/attempts`, tL);
  check('troisième tentative refusée (403)', third.status === 403, `statut ${third.status}`);
  check('le module B est débloqué après réussite', (await call('GET', `/assessments/${quizB.id}`, tL)).status === 200);

  const review = await call('GET', `/attempts/${attempt1}`, tL);
  check('relecture de la correction d\'une tentative terminée', review.status === 200 && review.json.questions.length === 3);

  const tOther = await register('Autre');
  check('un autre élève ne voit pas cette tentative (404)', (await call('GET', `/attempts/${attempt1}`, tOther)).status === 404);

  // ── Intégrité côté formateur ──
  console.log('\nIntégrité côté formateur');
  const firstQ = full.questions[0];
  const add = await call('POST', `/studio/assessments/${quizA.id}/questions`, tI, { type: 'true_false', text: 'Ajout tardif', correctAnswer: true });
  check('ajout de question refusé une fois le quiz commencé (409)', add.status === 409, `statut ${add.status}`);
  const typo = await call('PATCH', `/studio/questions/${firstQ.id}`, tI, { text: 'Combien font 2 + 2 ? (corrigé)' });
  check('correction du texte autorisée (200)', typo.status === 200, `statut ${typo.status}`);
  const pts = await call('PATCH', `/studio/questions/${firstQ.id}`, tI, { points: 5 });
  check('changement des points refusé (409)', pts.status === 409, `statut ${pts.status}`);
  const del = await call('DELETE', `/studio/assessments/${quizA.id}`, tI);
  check('suppression du quiz refusée (409)', del.status === 409, `statut ${del.status}`);

  await call('POST', `/studio/courses/${course.id}/publish`, tI, { published: false });
  console.log('\nFormation de test dépubliée (elle reste en base, invisible dans le catalogue).');
}

main()
  .then(() => {
    console.log(failures === 0 ? '\nTous les contrôles sont passés.' : `\n${failures} contrôle(s) en échec.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => { console.error('\nErreur :', e.message); process.exit(1); });
