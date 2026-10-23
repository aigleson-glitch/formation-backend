// Test de bout en bout : formateurs, éditeur, règle « mineurs », quiz vide, sécurité de connexion.
//   node scripts/smoke-staff.mjs        (l'API tourne : npm run dev dans une autre fenêtre)
// Crée des comptes et des formations de test « [TEST] ... » (dépubliés / désactivés à la fin).
// Variables facultatives : API_URL, ADMIN_EMAIL, ADMIN_PASSWORD.
import { readFileSync } from 'node:fs';

const API = process.env.API_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'ChangeMe123!';
const stamp = Date.now();
const PW = 'MotDePasseTest-2026';

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
  return { status: res.status, json };
}
const must = (r, expected, what) => {
  if (r.status !== expected) throw new Error(`${what} : statut ${r.status} (attendu ${expected}) ${JSON.stringify(r.json)}`);
  return r.json;
};
const login = async (email, password = PW) => must(await call('POST', '/auth/login', null, { identifier: email, password }), 200, `connexion ${email}`).token;

async function main() {
  console.log(`API : ${API}\n`);
  const created = { courses: [], staff: [] };

  // ── 1. Administration des comptes ─────────────────────────────
  console.log('Comptes formateurs');
  const tA = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const categories = must(await call('GET', '/categories'), 200, 'catégories');
  const categoryId = (Array.isArray(categories) ? categories : categories.categories)[0].id;

  const mk = (label, canTeachMinors) => call('POST', '/admin/users', tA, {
    role: 'instructor', email: `staff.${label}.${stamp}@example.com`, password: PW,
    firstName: 'Test', lastName: label, canTeachMinors,
  });
  const weak = await call('POST', '/admin/users', tA, { role: 'instructor', email: `weak.${stamp}@example.com`, password: 'court', firstName: 'a', lastName: 'b' });
  check('mot de passe trop court refusé (400)', weak.status === 400, weak.status);
  const plain = must(await mk('simple', false), 201, 'formateur sans habilité');
  const cert = must(await mk('habilite', true), 201, 'formateur habilité');
  created.staff.push(plain.id, cert.id);
  check('formateur créé : habilitation respectée', plain.canTeachMinors === false && cert.canTeachMinors === true);
  check('le hash du mot de passe n\'est jamais renvoyé', !JSON.stringify(plain).includes('passwordHash'));
  check('e-mail déjà utilisé refusé (409)', (await mk('simple', false)).status === 409);

  const tPlain = await login(plain.email);
  const tCert = await login(cert.email);
  check('un formateur n\'accède pas à l\'administration (403)', (await call('GET', '/admin/users', tPlain)).status === 403);
  check('sans connexion : 401', (await call('GET', '/admin/users')).status === 401);
  const list = must(await call('GET', '/admin/users?role=instructor&q=staff.habilite', tA), 200, 'liste');
  check('liste filtrée par rôle et recherche', list.items.some((u) => u.id === cert.id) && list.items.every((u) => u.role === 'instructor'));
  check('la liste ne contient aucun hash', !JSON.stringify(list).includes('passwordHash'));

  // ── 2. Règle « mineurs » ──────────────────────────────────────
  console.log('\nRègle « mineurs » (règle 15)');
  const denied = await call('POST', '/studio/courses', tPlain, { categoryId, title: `[TEST] Enfants refusé ${stamp}`, audiences: ['child'] });
  check('formateur non habilité : cours enfants refusé (403)', denied.status === 403, denied.status);

  // L'administrateur peut maintenant créer un cours pour mineurs (brouillon, sans formateur)
  const kids = must(await call('POST', '/studio/courses', tA, { categoryId, title: `[TEST] Enfants ${stamp}`, audiences: ['child'] }), 201, 'cours enfants par l\'admin');
  created.courses.push(kids.id);
  const km = must(await call('POST', `/studio/courses/${kids.id}/modules`, tA, { title: 'Module 1' }), 201, 'module');
  const kc = must(await call('POST', `/studio/modules/${km.id}/chapters`, tA, { title: 'Chapitre 1' }), 201, 'chapitre');
  must(await call('POST', `/studio/chapters/${kc.id}/lessons`, tA, { title: 'Leçon 1', content: 'Bonjour' }), 201, 'leçon');
  const noTeacher = await call('POST', `/studio/courses/${kids.id}/publish`, tA, { published: true });
  check('publication refusée sans formateur habilité (422)', noTeacher.status === 422 && /formateur/.test(noTeacher.json.error), noTeacher);

  check('seul l\'admin affecte un formateur (403)', (await call('POST', `/studio/courses/${kids.id}/instructors`, tCert, { userId: cert.id })).status === 403);
  const assignPlain = await call('POST', `/studio/courses/${kids.id}/instructors`, tA, { userId: plain.id });
  check('affectation d\'un formateur non habilité refusée (403)', assignPlain.status === 403, assignPlain);
  const assigned = must(await call('POST', `/studio/courses/${kids.id}/instructors`, tA, { userId: cert.id }), 201, 'affectation');
  check('formateur habilité affecté', assigned.instructors.some((i) => i.id === cert.id));
  check('affectation répétée sans doublon', (await call('POST', `/studio/courses/${kids.id}/instructors`, tA, { userId: cert.id })).json.instructors.length === 1);
  must(await call('POST', `/studio/courses/${kids.id}/publish`, tA, { published: true }), 200, 'publication');
  check('publication acceptée avec un formateur habilité', true);

  const lastTeacher = await call('DELETE', `/studio/courses/${kids.id}/instructors/${cert.id}`, tA);
  check('retirer le dernier formateur d\'un cours publié pour mineurs refusé (409)', lastTeacher.status === 409, lastTeacher);
  const revoke = await call('PATCH', `/admin/users/${cert.id}`, tA, { canTeachMinors: false });
  check('retirer l\'habilitation du dernier formateur refusé (409)', revoke.status === 409, revoke);
  const addAdult = await call('PATCH', `/studio/courses/${kids.id}`, tCert, { audiences: ['child', 'adult'] });
  check('le formateur habilité peut modifier le public de son cours (200)', addAdult.status === 200, addAdult);
  check('un formateur non affecté ne voit pas le cours (403)', (await call('GET', `/studio/courses/${kids.id}`, tPlain)).status === 403);
  const adminCannotBreak = await call('PATCH', `/admin/users/${plain.id}`, tA, { canTeachMinors: 'oui' });
  check('valeur invalide refusée (400)', adminCannotBreak.status === 400);
  check('désactiver son propre compte refusé (409)', (await call('PATCH', `/admin/users/${(await call('GET', '/auth/me', tA)).json.user.id}`, tA, { isActive: false })).status === 409);

  // ── 3. Éditeur complet ────────────────────────────────────────
  console.log('\nÉditeur formateur');
  const adult = must(await call('POST', '/studio/courses', tPlain, { categoryId, title: `[TEST] Éditeur ${stamp}`, audiences: ['adult'], sequentialUnlock: true }), 201, 'cours adulte');
  created.courses.push(adult.id);
  const mods = [];
  for (const n of ['A', 'B', 'C']) {
    const m = must(await call('POST', `/studio/courses/${adult.id}/modules`, tPlain, { title: `Module ${n}` }), 201, `module ${n}`);
    mods.push(m);
  }
  const chA = must(await call('POST', `/studio/modules/${mods[0].id}/chapters`, tPlain, { title: 'Chapitre A1' }), 201, 'chapitre');
  const lessons = [];
  for (const n of [1, 2, 3]) {
    lessons.push(must(await call('POST', `/studio/chapters/${chA.id}/lessons`, tPlain, { title: `Leçon ${n}`, content: `Texte ${n}` }), 201, `leçon ${n}`));
  }
  for (const m of mods.slice(1)) {
    const c = must(await call('POST', `/studio/modules/${m.id}/chapters`, tPlain, { title: 'Chapitre' }), 201, 'chapitre');
    must(await call('POST', `/studio/chapters/${c.id}/lessons`, tPlain, { title: 'Leçon', content: 'Texte' }), 201, 'leçon');
  }

  let tree = must(await call('GET', `/studio/courses/${adult.id}`, tPlain), 200, 'arbre');
  check('arbre complet d\'un brouillon : 3 modules, 3 leçons dans le premier chapitre',
    tree.modules.length === 3 && tree.modules[0].chapters[0].lessons.length === 3 && tree.isPublished === false);
  check('l\'arbre n\'envoie pas le contenu des leçons', !JSON.stringify(tree).includes('Texte 1'));
  check('l\'arbre indique le formateur et zéro inscrit', tree.instructors.some((i) => i.id === plain.id) && tree.enrollmentCount === 0);
  check('id invalide : 404 et non 500', (await call('GET', '/studio/courses/pas-un-uuid', tPlain)).status === 404);

  const full = must(await call('GET', `/studio/lessons/${lessons[0].id}`, tPlain), 200, 'leçon');
  check('une leçon se lit avec son contenu complet', full.content === 'Texte 1');
  check('titre de module modifiable', (await call('PATCH', `/studio/modules/${mods[0].id}`, tPlain, { title: 'Module A (renommé)' })).json.title === 'Module A (renommé)');
  check('titre de chapitre modifiable', (await call('PATCH', `/studio/chapters/${chA.id}`, tPlain, { title: 'Chapitre A1 bis' })).status === 200);
  const toVideo = await call('PATCH', `/studio/lessons/${lessons[0].id}`, tPlain, { type: 'video' });
  check('leçon passée en vidéo sans lien refusée (422)', toVideo.status === 422, toVideo);
  check('leçon passée en vidéo avec lien acceptée', (await call('PATCH', `/studio/lessons/${lessons[0].id}`, tPlain, { type: 'video', mediaUrl: 'https://exemple.com/v.mp4' })).status === 200);

  const newOrder = [lessons[2].id, lessons[0].id, lessons[1].id];
  must(await call('POST', `/studio/chapters/${chA.id}/lessons/reorder`, tPlain, { ids: newOrder }), 200, 'réordonner');
  tree = must(await call('GET', `/studio/courses/${adult.id}`, tPlain), 200, 'arbre');
  check('ordre des leçons modifié', tree.modules[0].chapters[0].lessons.map((l) => l.id).join() === newOrder.join());
  check('réordonner avec une liste incomplète refusé (422)', (await call('POST', `/studio/chapters/${chA.id}/lessons/reorder`, tPlain, { ids: [lessons[0].id] })).status === 422);
  check('réordonner avec un doublon refusé (422)', (await call('POST', `/studio/chapters/${chA.id}/lessons/reorder`, tPlain, { ids: [lessons[0].id, lessons[0].id, lessons[1].id] })).status === 422);
  const modOrder = [mods[2].id, mods[0].id, mods[1].id];
  must(await call('POST', `/studio/courses/${adult.id}/modules/reorder`, tPlain, { ids: modOrder }), 200, 'réordonner modules');
  tree = must(await call('GET', `/studio/courses/${adult.id}`, tPlain), 200, 'arbre');
  check('ordre des modules modifié', tree.modules.map((m) => m.id).join() === modOrder.join());

  // Suppression d'un chapitre portant un profil IA (la clé étrangère doit suivre)
  const ch2 = must(await call('POST', `/studio/modules/${mods[0].id}/chapters`, tPlain, { title: 'Chapitre à supprimer' }), 201, 'chapitre 2');
  const profile = JSON.parse(readFileSync(new URL('../prisma/examples/chapter-profile.example.json', import.meta.url), 'utf8'));
  delete profile.chapterId; profile.linkedLessonIds = [];
  must(await call('PUT', `/studio/chapters/${ch2.id}/ai-profile`, tPlain, profile), 200, 'profil IA');
  tree = must(await call('GET', `/studio/courses/${adult.id}`, tPlain), 200, 'arbre');
  check('l\'arbre signale le profil IA du chapitre', tree.modules.flatMap((m) => m.chapters).find((c) => c.id === ch2.id)?.hasAiProfile === true);
  check('chapitre avec profil IA supprimable (204)', (await call('DELETE', `/studio/chapters/${ch2.id}`, tPlain)).status === 204);
  const l4 = must(await call('POST', `/studio/chapters/${chA.id}/lessons`, tPlain, { title: 'À supprimer', content: 'x' }), 201, 'leçon à supprimer');
  check('leçon supprimable avant toute inscription (204)', (await call('DELETE', `/studio/lessons/${l4.id}`, tPlain)).status === 204);

  // ── 4. Quiz vide dans une formation publiée ─────────────────────
  console.log('\nQuiz sans question ajouté à une formation publiée');
  must(await call('POST', `/studio/courses/${adult.id}/publish`, tPlain, { published: true }), 200, 'publication cours adulte');
  const firstMod = (must(await call('GET', `/studio/courses/${adult.id}`, tPlain), 200, 'arbre')).modules[0];
  const emptyQuiz = must(await call('POST', `/studio/modules/${firstMod.id}/assessments`, tPlain, { type: 'quiz', title: 'Quiz vide' }), 201, 'quiz vide');
  tree = must(await call('GET', `/studio/courses/${adult.id}`, tPlain), 200, 'arbre');
  const qNode = tree.modules[0].assessments.find((a) => a.id === emptyQuiz.id);
  check('l\'arbre signale le quiz comme non jouable', qNode.playable === false && qNode.questionCount === 0);

  const email = `eleve.${stamp}@example.com`;
  const st = must(await call('POST', '/auth/register', null, { accountType: 'adult', email, password: PW, firstName: 'Eleve', lastName: 'Test', birthDate: '1990-01-01' }), 201, 'inscription élève').token;
  const enr = must(await call('POST', `/courses/${adult.id}/enroll`, st, {}), 201, 'inscription au cours').enrollment;
  const lessonIds = [];
  const course = must(await call('GET', `/courses/${adult.slug}`, st), 200, 'programme');
  for (const m of course.modules) for (const c of m.chapters) for (const l of c.lessons) lessonIds.push({ id: l.id, module: m.id });
  const firstModuleLessons = lessonIds.filter((l) => l.module === firstMod.id);
  for (const l of firstModuleLessons) must(await call('POST', `/lessons/${l.id}/complete`, st, {}), 200, 'leçon terminée');
  const nextModLesson = lessonIds.find((l) => l.module !== firstMod.id);
  const open = await call('GET', `/lessons/${nextModLesson.id}`, st);
  check('règle existante : le quiz obligatoire (même vide) verrouille le module suivant (403)', open.status === 403, open.status);
  const dropped = await call('DELETE', `/studio/assessments/${emptyQuiz.id}`, tPlain);
  check('le formateur supprime le quiz vide (204)', dropped.status === 204, dropped);
  const reopen = await call('GET', `/lessons/${nextModLesson.id}`, st);
  check('le module suivant se rouvre une fois le quiz vide supprimé', reopen.status === 200, reopen.status);

  // ── 5. Suppressions et ordre après inscription ──────────────────
  console.log('\nContenu d\'une formation suivie');
  const del = await call('DELETE', `/studio/lessons/${firstModuleLessons[0].id}`, tPlain);
  check('suppression d\'une leçon refusée une fois des élèves inscrits (409)', del.status === 409, del);
  check('suppression d\'un module refusée (409)', (await call('DELETE', `/studio/modules/${firstMod.id}`, tPlain)).status === 409);
  check('réordonner les modules refusé (409)', (await call('POST', `/studio/courses/${adult.id}/modules/reorder`, tPlain, { ids: tree.modules.map((m) => m.id).reverse() })).status === 409);
  check('corriger le texte d\'une leçon reste possible (200)', (await call('PATCH', `/studio/lessons/${firstModuleLessons[0].id}`, tPlain, { content: 'Texte corrigé' })).status === 200);
  check('réordonner les leçons d\'un chapitre reste possible (200)', (await call('POST', `/studio/chapters/${tree.modules[0].chapters[0].id}/lessons/reorder`, tPlain, { ids: tree.modules[0].chapters[0].lessons.map((l) => l.id).reverse() })).status === 200);
  tree = must(await call('GET', `/studio/courses/${adult.id}`, tPlain), 200, 'arbre');
  check('l\'arbre compte l\'inscrit', tree.enrollmentCount === 1);

  // ── 6. Sécurité de connexion ───────────────────────────────────
  console.log('\nSécurité');
  const bad1 = await call('POST', '/auth/login', null, { identifier: email, password: 'faux-mot-de-passe' });
  const bad2 = await call('POST', '/auth/login', null, { identifier: `inconnu.${stamp}@example.com`, password: 'faux-mot-de-passe' });
  check('même réponse pour un e-mail inconnu et un mauvais mot de passe', bad1.status === 401 && bad2.status === 401 && bad1.json.error === bad2.json.error);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: (await call('GET', '/auth/me', tA)).json.user.id, role: 'admin' })}.`;
  check('jeton non signé (alg « none ») refusé (401)', (await call('GET', '/admin/users', forged)).status === 401);

  // ── Nettoyage : rien de visible dans le catalogue, comptes de test désactivés ──
  for (const id of created.courses) await call('POST', `/studio/courses/${id}/publish`, tA, { published: false });
  const off = [];
  for (const id of created.staff) off.push(await call('PATCH', `/admin/users/${id}`, tA, { isActive: false }));
  check('désactivation d\'un formateur autorisée, avec avertissement des formations laissées sans formateur',
    off.every((r) => r.status === 200) && Array.isArray(off.find((r) => r.json.id === cert.id)?.json.minorCoursesWithoutTeacher));
  console.log('\nFormations de test dépubliées, formateurs de test désactivés (ils restent en base).');

  console.log(failures ? `\n${failures} contrôle(s) en échec.` : '\nTous les contrôles sont passés.');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('\nERREUR :', e.message); process.exit(1); });
