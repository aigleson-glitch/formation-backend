// Essai des devoirs sans interface formateur : crée un devoir de démonstration, puis le corrige.
//   node scripts/demo-devoir.mjs creer <slug> [numéro-du-module | tous]   ajoute le devoir (module 1 par défaut)
//   node scripts/demo-devoir.mjs corriger <slug> [note]                   corrige les remises en attente (note sur 100, 80 par défaut)
//   node scripts/demo-devoir.mjs refaire <slug>                           demande de refaire les remises en attente
// Le devoir est NON obligatoire : il ne change ni la progression ni le déblocage des modules.
// Seuls les devoirs intitulés « Devoir de démonstration » sont corrigés : les vraies copies ne sont jamais touchées.
// Variables facultatives : API_URL, INSTRUCTOR_EMAIL, INSTRUCTOR_PASSWORD.

const API = process.env.API_URL ?? 'http://localhost:3000';
const EMAIL = process.env.INSTRUCTOR_EMAIL ?? 'formateur@example.com';
const PASSWORD = process.env.INSTRUCTOR_PASSWORD ?? 'ChangeMe123!';
const TITLE = 'Devoir de démonstration';
const [command, slug, arg] = process.argv.slice(2);

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

async function create(token, course) {
  const modules = course.modules ?? [];
  if (modules.length === 0) throw new Error('Cette formation n\'a aucun module.');
  const which = (arg ?? '1').toLowerCase();
  let targets;
  if (which === 'tous') targets = modules;
  else {
    const n = Number(which);
    if (!Number.isInteger(n) || n < 1 || n > modules.length) throw new Error(`Module « ${which} » inconnu : choisissez un numéro de 1 à ${modules.length}, ou « tous ».`);
    targets = [modules[n - 1]];
  }
  for (const mod of targets) {
    if ((mod.assessments ?? []).some((a) => a.title === TITLE)) {
      console.log(`  - « ${mod.title} » : le devoir existe déjà, rien à faire.`);
      continue;
    }
    must(await call('POST', `/studio/modules/${mod.id}/assignments`, token, {
      type: 'assignment', title: TITLE, passMark: 60, maxAttempts: 3, isRequired: false,
      instructions: 'Rédigez en quelques lignes ce que vous avez retenu de ce module, et ajoutez si vous le souhaitez un lien (https) vers un document en ligne.',
    }), 201, `création du devoir (${mod.title})`);
    console.log(`  + « ${mod.title} » : devoir ajouté.`);
  }
  console.log('\nOuvrez le module dans l\'application, puis « Voir le devoir ». Après une remise, lancez la commande « corriger » ou « refaire ».');
}

async function review(token, course, decision) {
  const queue = must(await call('GET', `/studio/submissions?status=open&courseId=${course.id}&pageSize=50`, token), 200, 'file de correction');
  const mine = queue.items.filter((s) => s.assignment.title === TITLE);
  if (mine.length === 0) {
    console.log(`Aucune remise en attente pour « ${TITLE} » dans cette formation.`);
    return;
  }
  const scorePct = arg === undefined ? 80 : Number(arg);
  if (decision === 'graded' && !(scorePct >= 0 && scorePct <= 100)) throw new Error('La note doit être un nombre entre 0 et 100.');
  for (const s of mine) {
    const body = decision === 'graded'
      ? { decision, scorePct, feedback: 'Correction de démonstration : bon travail, pensez à détailler davantage vos exemples.' }
      : { decision, feedback: 'Correction de démonstration : merci de développer votre réponse puis de renvoyer le devoir.' };
    must(await call('POST', `/studio/submissions/${s.id}/grade`, token, body), 200, 'correction');
    const who = `${s.student.firstName} ${s.student.lastName}`;
    console.log(decision === 'graded' ? `  Remise ${s.attemptNo} de ${who} corrigée : ${scorePct} %.` : `  Remise ${s.attemptNo} de ${who} : à refaire.`);
  }
  console.log('\nRechargez la page du devoir dans l\'application pour voir la correction.');
}

async function main() {
  if (!['creer', 'corriger', 'refaire'].includes(command) || !slug) {
    console.error('Usage :\n  node scripts/demo-devoir.mjs creer <slug> [numéro-du-module | tous]\n  node scripts/demo-devoir.mjs corriger <slug> [note]\n  node scripts/demo-devoir.mjs refaire <slug>');
    process.exit(1);
  }
  const token = must(await call('POST', '/auth/login', null, { identifier: EMAIL, password: PASSWORD }), 200, 'connexion du formateur').token;
  const course = must(await call('GET', `/courses/${encodeURIComponent(slug)}`, token), 200, `formation « ${slug} »`);
  console.log(`Formation « ${course.title} »\n`);
  if (command === 'creer') await create(token, course);
  else await review(token, course, command === 'corriger' ? 'graded' : 'resubmit');
}

main().catch((e) => { console.error('\nErreur :', e.message); process.exit(1); });
