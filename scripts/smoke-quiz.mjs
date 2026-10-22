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
  const lessons = [];
  for (const name of ['A', 'B']) {
    const m = must(await call('POST', `/studio/courses/${course.id}/modules`, tI, { title: `Module ${name}` }), 201, `module ${name}`);
    const ch = must(await call('POST', `/studio/modules/${m.id}/chapters`, tI, { title: `Chapitre ${name}` }), 201, `chapitre ${name}`);
    lessons.push(must(await call('POST', `/studio/chapters/${ch.id}/lessons`, tI, { title: `Leçon ${name}`, content: 'Contenu de test' }), 201, `leçon ${name}`));
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
  check('1re tentative ratée, il en reste une : bonnes réponses et explications masquées',
    res1.json?.answersRevealed === false && !res1.text.includes(SECRET) && res1.json?.questions?.every((q) => q.options.every((o) => !('isCorrect' in o))), 'fuite des bonnes réponses');
  check('… mais le résultat de chaque question reste visible', res1.json?.questions?.every((q) => q.isCorrect === false));
  const reread1 = await call('GET', `/attempts/${attempt1}`, tL);
  check('la relecture avant réussite ne révèle rien non plus', reread1.status === 200 && reread1.json.answersRevealed === false && !reread1.text.includes(SECRET));

  const twice = await call('POST', `/attempts/${attempt1}/submit`, tL, { answers: right });
  check('double soumission refusée (409)', twice.status === 409, `statut ${twice.status}`);
  check('le module B reste verrouillé après un échec', (await call('GET', `/assessments/${quizB.id}`, tL)).status === 403);

  const start2 = must(await call('POST', `/assessments/${quizA.id}/attempts`, tL), 201, 'tentative 2');
  const res2 = await call('POST', `/attempts/${start2.attempt.id}/submit`, tL, { answers: right });
  check('tentative 2 (tout juste) : 100 %, réussi', res2.status === 200 && res2.json.attempt.scorePct === 100 && res2.json.attempt.passed === true, JSON.stringify(res2.json?.attempt));
  check('module compétent, plus de tentatives', res2.json?.moduleStatus === 'competent' && res2.json?.attemptsLeft === 0);
  check('réussite : bonnes réponses et explications révélées', res2.json?.answersRevealed === true && res2.text.includes(SECRET));

  const third = await call('POST', `/assessments/${quizA.id}/attempts`, tL);
  check('troisième tentative refusée (403)', third.status === 403, `statut ${third.status}`);
  check('le module B est débloqué après réussite', (await call('GET', `/assessments/${quizB.id}`, tL)).status === 200);

  const review = await call('GET', `/attempts/${attempt1}`, tL);
  check('après réussite, la relecture d\'une ancienne tentative montre la correction',
    review.status === 200 && review.json.questions.length === 3 && review.json.answersRevealed === true && review.text.includes(SECRET));

  const tOther = await register('Autre');
  check('un autre élève ne voit pas cette tentative (404)', (await call('GET', `/attempts/${attempt1}`, tOther)).status === 404);

  // ── Bonnes réponses : révélées seulement après réussite ou à la dernière tentative ──
  console.log('\nCorrection des réponses');
  const tThird = await register('Troisieme');
  must(await call('POST', `/courses/${course.id}/enroll`, tThird, {}), 201, 'inscription élève 3');
  const tr1 = must(await call('POST', `/assessments/${quizA.id}/attempts`, tThird), 201, 'tentative 1 élève 3');
  const rr1 = await call('POST', `/attempts/${tr1.attempt.id}/submit`, tThird, { answers: wrong });
  check('élève 3, tentative 1 sur 2 ratée : pas de bonnes réponses ni d\'explications',
    rr1.status === 200 && rr1.json.answersRevealed === false && !rr1.text.includes(SECRET) && rr1.json.questions.every((q) => q.options.every((o) => !('isCorrect' in o))), `statut ${rr1.status}`);
  const tr2 = must(await call('POST', `/assessments/${quizA.id}/attempts`, tThird), 201, 'tentative 2 élève 3');
  const rr2 = await call('POST', `/attempts/${tr2.attempt.id}/submit`, tThird, { answers: wrong });
  check('élève 3, dernière tentative utilisée (même ratée) : correction révélée',
    rr2.status === 200 && rr2.json.answersRevealed === true && rr2.text.includes(SECRET) && rr2.json.questions.every((q) => q.options.some((o) => o.isCorrect === true)), `statut ${rr2.status}`);
  const rr1again = await call('GET', `/attempts/${tr1.attempt.id}`, tThird);
  check('élève 3 : la tentative 1 devient lisible une fois les tentatives épuisées', rr1again.status === 200 && rr1again.json.answersRevealed === true && rr1again.text.includes(SECRET));

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

  // ── Quiz obligatoire ajouté après coup dans un module déjà validé ──
  console.log('\nQuiz obligatoire ajouté à un module déjà validé');
  const bOpen = () => call('GET', `/assessments/${quizB.id}`, tL).then((r) => r.status);
  check('avant : le module B est ouvert pour l\'élève (200)', (await bOpen()) === 200);

  const quizA2 = must(await call('POST', `/studio/modules/${modules[0].id}/assessments`, tI, { type: 'quiz', title: 'Quiz A2 (ajouté après coup)', maxAttempts: 2 }), 201, 'quiz A2');
  check('l\'ajout recalcule les résultats d\'au moins 1 élève', quizA2.studentsRecalculated >= 1, JSON.stringify(quizA2));
  check('le module A n\'est plus validé : le module B se reverrouille (403)', (await bOpen()) === 403);

  must(await call('POST', `/studio/assessments/${quizA2.id}/questions`, tI, { type: 'true_false', text: 'Question du quiz A2', correctAnswer: true }), 201, 'question A2');
  const a2Full = must(await call('GET', `/studio/assessments/${quizA2.id}`, tI), 200, 'vue formateur A2');
  const a2Right = a2Full.questions.map((q) => ({ questionId: q.id, optionIds: q.options.filter((o) => o.isCorrect).map((o) => o.id) }));
  const a2Start = must(await call('POST', `/assessments/${quizA2.id}/attempts`, tL), 201, 'tentative A2');
  const a2Res = await call('POST', `/attempts/${a2Start.attempt.id}/submit`, tL, { answers: a2Right });
  check('après réussite du nouveau quiz : module A de nouveau compétent', a2Res.json?.moduleStatus === 'competent', JSON.stringify(a2Res.json?.moduleStatus));
  check('le module B est de nouveau ouvert (200)', (await bOpen()) === 200);

  const quizA3 = must(await call('POST', `/studio/modules/${modules[0].id}/assessments`, tI, { type: 'quiz', title: 'Quiz A3' }), 201, 'quiz A3');
  check('un 2e quiz obligatoire reverrouille le module B (403)', (await bOpen()) === 403);
  const off = await call('PATCH', `/studio/assessments/${quizA3.id}`, tI, { isRequired: false });
  check('le rendre non obligatoire : réponse 200', off.status === 200, `statut ${off.status}`);
  check('… et le module B se rouvre (200)', (await bOpen()) === 200);
  const on = await call('PATCH', `/studio/assessments/${quizA3.id}`, tI, { isRequired: true });
  check('le rendre à nouveau obligatoire reverrouille le module B (403)', on.status === 200 && (await bOpen()) === 403);
  const delA3 = await call('DELETE', `/studio/assessments/${quizA3.id}`, tI);
  check('supprimer ce quiz (sans tentative) : 204', delA3.status === 204, `statut ${delA3.status}`);
  check('… et le module B se rouvre (200)', (await bOpen()) === 200);

  // ── Fin de formation : modules validés ET toutes les leçons terminées ──
  console.log('\nFin de formation');
  const answersRight = async (assessmentId) => {
    const v = must(await call('GET', `/studio/assessments/${assessmentId}`, tI), 200, 'vue formateur');
    return v.questions.map((q) => ({ questionId: q.id, optionIds: q.options.filter((o) => o.isCorrect).map((o) => o.id) }));
  };
  const passQuiz = async (token, assessmentId) => {
    const s = must(await call('POST', `/assessments/${assessmentId}/attempts`, token), 201, 'démarrage du quiz');
    return call('POST', `/attempts/${s.attempt.id}/submit`, token, { answers: await answersRight(assessmentId) });
  };
  const myEnrollment = async (token) => must(await call('GET', '/my/enrollments', token), 200, 'mes inscriptions').find((e) => e.courseId === course.id);
  const doLesson = (token, lesson) => call('POST', `/lessons/${lesson.id}/complete`, token);

  // Élève 1 : leçons d'abord, dernier quiz ensuite → c'est le quiz qui termine la formation
  check('élève 1 : inscription encore « active » au départ', (await myEnrollment(tL)).status === 'active');
  must(await doLesson(tL, lessons[0]), 200, 'leçon A');
  const lastLesson1 = await doLesson(tL, lessons[1]);
  check('élève 1 : toutes les leçons faites mais quiz B non réussi → pas terminée',
    lastLesson1.status === 200 && lastLesson1.json.courseCompleted === false && (await myEnrollment(tL)).status === 'active');
  const passB1 = await passQuiz(tL, quizB.id);
  const enr1 = await myEnrollment(tL);
  check('élève 1 : dernier quiz réussi → formation terminée, avec la date',
    passB1.status === 200 && enr1.status === 'completed' && enr1.completedAt, `statut ${enr1.status}`);

  // Élève 2 : quiz d'abord, dernière leçon ensuite → c'est la leçon qui termine la formation
  must(await call('POST', `/courses/${course.id}/enroll`, tOther, {}), 201, 'inscription élève 2');
  await passQuiz(tOther, quizA.id);
  await passQuiz(tOther, quizA2.id);
  must(await doLesson(tOther, lessons[0]), 200, 'leçon A (élève 2)');
  await passQuiz(tOther, quizB.id);
  check('élève 2 : modules validés mais une leçon reste à faire → pas terminée', (await myEnrollment(tOther)).status === 'active');
  const lastLesson2 = await doLesson(tOther, lessons[1]);
  check('élève 2 : dernière leçon terminée → formation terminée',
    lastLesson2.status === 200 && lastLesson2.json.courseCompleted === true && (await myEnrollment(tOther)).status === 'completed');

  // Une formation terminée le reste, même si un quiz obligatoire est ajouté ensuite
  const quizA4 = must(await call('POST', `/studio/modules/${modules[0].id}/assessments`, tI, { type: 'quiz', title: 'Quiz A4 (après la fin)' }), 201, 'quiz A4');
  check('un quiz obligatoire ajouté après la fin ne reprend pas le statut « terminée »', (await myEnrollment(tL)).status === 'completed');
  await call('DELETE', `/studio/assessments/${quizA4.id}`, tI);

  await call('POST', `/studio/courses/${course.id}/publish`, tI, { published: false });
  console.log('\nFormation de test dépubliée (elle reste en base, invisible dans le catalogue).');
}

main()
  .then(() => {
    console.log(failures === 0 ? '\nTous les contrôles sont passés.' : `\n${failures} contrôle(s) en échec.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => { console.error('\nErreur :', e.message); process.exit(1); });
