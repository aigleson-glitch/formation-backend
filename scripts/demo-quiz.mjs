// Ajoute un quiz de démonstration à un ou plusieurs modules d'une formation existante, pour essayer l'écran du quiz.
//   node scripts/demo-quiz.mjs <slug-de-la-formation> [numéro-du-module | tous]
// Exemples : node scripts/demo-quiz.mjs initiation-informatique          (module 1, par défaut)
//            node scripts/demo-quiz.mjs initiation-informatique 2        (module 2)
//            node scripts/demo-quiz.mjs initiation-informatique tous     (tous les modules)
// Les quiz sont NON obligatoires : ils ne changent ni la progression ni le déblocage des modules.
// Variables facultatives : API_URL, INSTRUCTOR_EMAIL, INSTRUCTOR_PASSWORD.
// On peut le relancer sans risque : un module qui a déjà le quiz est laissé tel quel.

const API = process.env.API_URL ?? 'http://localhost:3000';
const EMAIL = process.env.INSTRUCTOR_EMAIL ?? 'formateur@example.com';
const PASSWORD = process.env.INSTRUCTOR_PASSWORD ?? 'ChangeMe123!';
const TITLE = 'Quiz de démonstration';
const slug = process.argv[2];
const which = (process.argv[3] ?? '1').toLowerCase();

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

const QUESTIONS = [
  { type: 'single', text: 'Combien font 2 + 2 ?', explanation: '2 + 2 = 4.', points: 1,
    options: [{ text: '3', isCorrect: false }, { text: '4', isCorrect: true }, { text: '5', isCorrect: false }] },
  { type: 'multiple', text: 'Quels nombres sont pairs ?', explanation: '2 et 8 sont divisibles par 2.', points: 2,
    options: [{ text: '2', isCorrect: true }, { text: '7', isCorrect: false }, { text: '8', isCorrect: true }, { text: '9', isCorrect: false }] },
  { type: 'true_false', text: 'Le soleil se lève à l\'ouest.', explanation: 'Il se lève à l\'est.', points: 1, correctAnswer: false },
];

async function addQuiz(token, mod) {
  if ((mod.assessments ?? []).some((a) => a.title === TITLE)) {
    console.log(`  - « ${mod.title} » : le quiz existe déjà, rien à faire.`);
    return;
  }
  const quiz = must(await call('POST', `/studio/modules/${mod.id}/assessments`, token, {
    type: 'quiz', title: TITLE, passMark: 60, maxAttempts: 3, timeLimitMin: 10, isRequired: false,
    instructions: 'Quiz pour essayer l\'écran : 3 questions, 10 minutes, réussite à 60 %.',
  }), 201, `création du quiz (${mod.title})`);
  for (const [i, q] of QUESTIONS.entries()) {
    must(await call('POST', `/studio/assessments/${quiz.id}/questions`, token, q), 201, `question ${i + 1} (${mod.title})`);
  }
  console.log(`  + « ${mod.title} » : quiz ajouté (3 questions).`);
}

async function main() {
  if (!slug) {
    console.error('Indiquez la formation : node scripts/demo-quiz.mjs <slug> [numéro-du-module | tous]\n(le slug est le mot qui suit /cours/ dans l\'adresse de la formation)');
    process.exit(1);
  }
  const token = must(await call('POST', '/auth/login', null, { identifier: EMAIL, password: PASSWORD }), 200, 'connexion du formateur').token;
  const course = must(await call('GET', `/courses/${encodeURIComponent(slug)}`, token), 200, `formation « ${slug} »`);
  const modules = course.modules ?? [];
  if (modules.length === 0) throw new Error('Cette formation n\'a aucun module.');

  console.log(`Formation « ${course.title} » : ${modules.length} module(s).`);
  modules.forEach((m, i) => console.log(`  ${i + 1}. ${m.title}`));

  let targets;
  if (which === 'tous') targets = modules;
  else {
    const n = Number(which);
    if (!Number.isInteger(n) || n < 1 || n > modules.length) throw new Error(`Module « ${which} » inconnu : choisissez un numéro de 1 à ${modules.length}, ou « tous ».`);
    targets = [modules[n - 1]];
  }
  console.log('');
  for (const mod of targets) await addQuiz(token, mod);
  console.log('\nOuvrez le module dans l\'application : le quiz apparaît dans la liste des évaluations.');
}

main().catch((e) => { console.error('\nErreur :', e.message); process.exit(1); });
