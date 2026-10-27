import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResults } from '../src/lib/results.js';

// Jeu de données minimal : une inscription, une formation, deux modules.
const base = () => ({
  enrollments: [{ id: 'e1', status: 'active', course: { id: 'c1', title: 'Formation', slug: 'formation' } }],
  modules: [
    { id: 'm2', courseId: 'c1', title: 'Module 2', position: 2 },
    { id: 'm1', courseId: 'c1', title: 'Module 1', position: 1 },
  ],
  assessments: [],
  lessons: [],
  lessonProgress: [],
  attempts: [],
  submissions: [],
  moduleResults: [],
});
const quiz = (id, moduleId, extra = {}) => ({ id, moduleId, type: 'quiz', title: `Quiz ${id}`, isRequired: true, passMark: 70, maxAttempts: 3, position: 1, ...extra });
const devoir = (id, moduleId, extra = {}) => ({ id, moduleId, type: 'assignment', title: `Devoir ${id}`, isRequired: true, passMark: 60, maxAttempts: 3, position: 2, ...extra });
const module1 = (r) => r[0].modules.find((m) => m.id === 'm1');

test('aucune inscription → aucune formation', () => {
  assert.deepEqual(buildResults({ ...base(), enrollments: [] }), []);
});

test('les modules sont classés par position', () => {
  const r = buildResults(base());
  assert.deepEqual(r[0].modules.map((m) => m.id), ['m1', 'm2']);
});

test('quiz réussi à la 2e tentative : réussi, 2 tentatives, meilleure note, module compétent', () => {
  const d = base();
  d.assessments = [quiz('q1', 'm1')];
  d.attempts = [
    { enrollmentId: 'e1', assessmentId: 'q1', status: 'submitted', scorePct: '40.00', passed: false },
    { enrollmentId: 'e1', assessmentId: 'q1', status: 'submitted', scorePct: '85.50', passed: true },
  ];
  d.moduleResults = [{ enrollmentId: 'e1', moduleId: 'm1', status: 'competent', scorePct: '85.50' }];
  const m = module1(buildResults(d));
  const a = m.assessments[0];
  assert.equal(a.state, 'passed');
  assert.equal(a.attemptsUsed, 2);
  assert.equal(a.bestScorePct, 85.5);
  assert.equal(a.kind, 'quiz');
  assert.equal(m.status, 'competent');
  assert.equal(m.basis, 'evaluations');
  assert.equal(m.scorePct, 85.5);
  assert.equal(m.passedCount, 1);
  assert.equal(m.requiredCount, 1);
});

test('quiz raté : « non réussi » et module pas encore compétent', () => {
  const d = base();
  d.assessments = [quiz('q1', 'm1')];
  d.attempts = [{ enrollmentId: 'e1', assessmentId: 'q1', status: 'submitted', scorePct: '30', passed: false }];
  const m = module1(buildResults(d));
  assert.equal(m.assessments[0].state, 'failed');
  assert.equal(m.status, 'not_yet');
  assert.equal(m.scorePct, 30);
});

test('tentative en cours seulement : « en cours », aucune tentative comptée, pas de note', () => {
  const d = base();
  d.assessments = [quiz('q1', 'm1')];
  d.attempts = [{ enrollmentId: 'e1', assessmentId: 'q1', status: 'in_progress', scorePct: null, passed: null }];
  const a = module1(buildResults(d)).assessments[0];
  assert.equal(a.state, 'in_progress');
  assert.equal(a.attemptsUsed, 0);
  assert.equal(a.bestScorePct, null);
});

test('évaluation jamais tentée : « none », module pas encore compétent, score nul', () => {
  const d = base();
  d.assessments = [quiz('q1', 'm1')];
  const m = module1(buildResults(d));
  assert.equal(m.assessments[0].state, 'none');
  assert.equal(m.status, 'not_yet');
  assert.equal(m.scorePct, null);
});

test('devoir : en attente, puis à refaire (ne consomme pas de remise), puis réussi', () => {
  const sub = (attemptNo, status, extra = {}) => ({ enrollmentId: 'e1', assessmentId: 'd1', attemptNo, status, scorePct: null, passed: null, ...extra });
  const run = (submissions) => {
    const d = base();
    d.assessments = [devoir('d1', 'm1')];
    d.submissions = submissions;
    return module1(buildResults(d)).assessments[0];
  };
  assert.equal(run([sub(1, 'submitted')]).state, 'pending');
  assert.equal(run([sub(1, 'in_review')]).state, 'pending');

  const redo = run([sub(1, 'resubmit')]);
  assert.equal(redo.state, 'resubmit');
  assert.equal(redo.attemptsUsed, 0);

  const failed = run([sub(1, 'graded', { scorePct: '40', passed: false })]);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.attemptsUsed, 1);

  const passed = run([sub(1, 'resubmit'), sub(2, 'graded', { scorePct: '85', passed: true })]);
  assert.equal(passed.state, 'passed');
  assert.equal(passed.attemptsUsed, 1);
  assert.equal(passed.bestScorePct, 85);
  assert.equal(passed.kind, 'assignment');
});

test('la dernière remise décide de l\'état quand rien n\'est encore réussi', () => {
  const d = base();
  d.assessments = [devoir('d1', 'm1')];
  d.submissions = [
    { enrollmentId: 'e1', assessmentId: 'd1', attemptNo: 2, status: 'submitted', scorePct: null, passed: null },
    { enrollmentId: 'e1', assessmentId: 'd1', attemptNo: 1, status: 'graded', scorePct: '40', passed: false },
  ];
  assert.equal(module1(buildResults(d)).assessments[0].state, 'pending');
});

test('module sans évaluation obligatoire : compétent quand toutes les leçons sont terminées', () => {
  const d = base();
  d.lessons = [{ id: 'l1', moduleId: 'm1' }, { id: 'l2', moduleId: 'm1' }];
  d.lessonProgress = [{ enrollmentId: 'e1', lessonId: 'l1' }];
  let m = module1(buildResults(d));
  assert.equal(m.basis, 'lessons');
  assert.equal(m.status, 'not_yet');
  assert.deepEqual(m.lessons, { done: 1, total: 2 });

  d.lessonProgress.push({ enrollmentId: 'e1', lessonId: 'l2' });
  m = module1(buildResults(d));
  assert.equal(m.status, 'competent');
});

test('une évaluation facultative ne change ni le statut ni le score du module', () => {
  const d = base();
  d.lessons = [{ id: 'l1', moduleId: 'm1' }];
  d.lessonProgress = [{ enrollmentId: 'e1', lessonId: 'l1' }];
  d.assessments = [quiz('q1', 'm1', { isRequired: false })];
  d.attempts = [{ enrollmentId: 'e1', assessmentId: 'q1', status: 'submitted', scorePct: '10', passed: false }];
  const m = module1(buildResults(d));
  assert.equal(m.basis, 'lessons');
  assert.equal(m.status, 'competent');
  assert.equal(m.scorePct, null);
  assert.equal(m.requiredCount, 0);
  assert.equal(m.assessments[0].isRequired, false);
});

test('avec une évaluation obligatoire, le statut vient du résultat enregistré (celui qui verrouille la suite)', () => {
  const d = base();
  d.lessons = [{ id: 'l1', moduleId: 'm1' }];
  d.lessonProgress = [{ enrollmentId: 'e1', lessonId: 'l1' }]; // toutes les leçons faites…
  d.assessments = [quiz('q1', 'm1')];                            // …mais le quiz obligatoire n'est pas réussi
  assert.equal(module1(buildResults(d)).status, 'not_yet');
});

test('score du module : moyenne des meilleures notes des évaluations obligatoires tentées', () => {
  const d = base();
  d.assessments = [quiz('q1', 'm1'), devoir('d1', 'm1')];
  d.attempts = [{ enrollmentId: 'e1', assessmentId: 'q1', status: 'submitted', scorePct: '100', passed: true }];
  d.submissions = [{ enrollmentId: 'e1', assessmentId: 'd1', attemptNo: 1, status: 'graded', scorePct: '60', passed: true }];
  d.moduleResults = [{ enrollmentId: 'e1', moduleId: 'm1', status: 'competent', scorePct: '80' }];
  const m = module1(buildResults(d));
  assert.equal(m.scorePct, 80);
  assert.equal(m.passedCount, 2);
});

test('deux inscriptions : chacune ne voit que ses propres tentatives', () => {
  const d = base();
  d.enrollments.push({ id: 'e2', status: 'completed', course: { id: 'c1', title: 'Formation', slug: 'formation' } });
  d.assessments = [quiz('q1', 'm1')];
  d.attempts = [{ enrollmentId: 'e2', assessmentId: 'q1', status: 'submitted', scorePct: '90', passed: true }];
  const r = buildResults(d);
  assert.equal(r[0].modules[0].assessments[0].state, 'none');
  assert.equal(r[1].modules[0].assessments[0].state, 'passed');
  assert.equal(r[1].enrollmentStatus, 'completed');
});
