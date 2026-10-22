// Vérifie qu'il n'existe jamais deux notes pour la même leçon, même si plusieurs enregistrements arrivent en même temps :
//   node scripts/smoke-notes.mjs      (le serveur doit tourner : npm run dev)
// Crée un apprenant de test et l'inscrit à « Initiation à l'informatique » (gratuite).
// Variable facultative : API_URL.

const API = process.env.API_URL ?? 'http://localhost:3000';
const stamp = Date.now();
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  OK  ' : ' ECHEC'}  ${label}${ok ? '' : detail ? `  →  ${detail}` : ''}`);
  if (!ok) failures++;
};

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

async function main() {
  console.log(`API : ${API}\n`);
  const token = must(await call('POST', '/auth/register', null, {
    accountType: 'adult', email: `smoke.notes.${stamp}@example.com`, password: 'MotDePasseTest1',
    firstName: 'Test', lastName: 'Notes', birthDate: '1990-01-01',
  }), 201, 'inscription').token;

  const courses = must(await call('GET', '/courses', token), 200, 'catalogue');
  const course = courses.find((c) => c.slug === 'initiation-informatique');
  if (!course) throw new Error('Formation « initiation-informatique » introuvable : lancez npm run db:seed');
  must(await call('POST', `/courses/${course.id}/enroll`, token, {}), 201, 'inscription à la formation');

  const enrollments = must(await call('GET', '/my/enrollments', token), 200, 'mes inscriptions');
  const next = must(await call('GET', `/my/enrollments/${enrollments[0].id}/continue`, token), 200, 'première leçon');
  const lessonId = next.lessonId;
  check('une première leçon est disponible', !!lessonId);

  // 8 enregistrements simultanés de la même note
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    call('PUT', `/lessons/${lessonId}/note`, token, { content: `Version ${i + 1}` })));
  check('les 8 enregistrements simultanés réussissent (200)', results.every((r) => r.status === 200), results.map((r) => r.status).join(','));

  const mine = must(await call('GET', '/my/notes', token), 200, 'mes notes');
  const forLesson = mine.filter((n) => n.lesson.id === lessonId);
  check('une seule note pour cette leçon', forLesson.length === 1, `${forLesson.length} notes`);

  const lesson = must(await call('GET', `/lessons/${lessonId}`, token), 200, 'lecture de la leçon');
  check('la leçon renvoie cette note', /^Version [1-8]$/.test(lesson.note), lesson.note);

  must(await call('PUT', `/lessons/${lessonId}/note`, token, { content: 'Texte final' }), 200, 'mise à jour');
  const after = must(await call('GET', '/my/notes', token), 200, 'mes notes');
  const only = after.filter((n) => n.lesson.id === lessonId);
  check('une mise à jour modifie la note existante', only.length === 1 && only[0].content === 'Texte final');
}

main()
  .then(() => {
    console.log(failures === 0 ? '\nTous les contrôles sont passés.' : `\n${failures} contrôle(s) en échec.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => { console.error('\nErreur :', e.message); process.exit(1); });
