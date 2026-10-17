import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTrueFalseOptions, checkOptions, gradeQuestion, parseAnswers, gradeAttempt, moduleOutcome, isExpired, deadlineOf, GRACE_MS,
} from '../src/lib/quiz.js';

const q = (id, type, points, opts) => ({ id, type, points, options: opts.map(([oid, isCorrect]) => ({ id: oid, isCorrect })) });
const single = q('q1', 'single', 1, [['a', false], ['b', true], ['c', false]]);
const multi = q('q2', 'multiple', 2, [['d', true], ['e', false], ['f', true]]);

test('choix unique : bonne et mauvaise réponse', () => {
  assert.deepEqual(gradeQuestion(single, ['b']), { isCorrect: true, points: 1 });
  assert.deepEqual(gradeQuestion(single, ['a']), { isCorrect: false, points: 0 });
});

test('choix multiple : tout ou rien', () => {
  assert.equal(gradeQuestion(multi, ['d', 'f']).points, 2);
  assert.equal(gradeQuestion(multi, ['d']).points, 0, 'une bonne réponse sur deux ne suffit pas');
  assert.equal(gradeQuestion(multi, ['d', 'e', 'f']).points, 0, 'une mauvaise option en plus annule tout');
});

test('aucune réponse : 0 point', () => {
  assert.deepEqual(gradeQuestion(single, []), { isCorrect: false, points: 0 });
});

test('parseAnswers : refuse question inconnue, doublon, option étrangère, deux choix sur choix unique', () => {
  const qs = [single, multi];
  assert.throws(() => parseAnswers(qs, [{ questionId: 'zzz', optionIds: [] }]), { status: 400 });
  assert.throws(() => parseAnswers(qs, [{ questionId: 'q1', optionIds: ['b'] }, { questionId: 'q1', optionIds: ['a'] }]), { status: 400 });
  assert.throws(() => parseAnswers(qs, [{ questionId: 'q1', optionIds: ['d'] }]), { status: 400 });
  assert.throws(() => parseAnswers(qs, [{ questionId: 'q1', optionIds: ['a', 'b'] }]), { status: 400 });
});

test('parseAnswers : retire les doublons et accepte les questions laissées sans réponse', () => {
  const m = parseAnswers([single, multi], [{ questionId: 'q2', optionIds: ['d', 'd', 'f'] }]);
  assert.deepEqual(m.get('q2'), ['d', 'f']);
  assert.equal(m.has('q1'), false);
});

test('gradeAttempt : pourcentage pondéré par les points, arrondi à 2 décimales', () => {
  const answers = new Map([['q1', ['b']]]); // 1 point sur 3
  const g = gradeAttempt([single, multi], answers);
  assert.equal(g.earned, 1);
  assert.equal(g.total, 3);
  assert.equal(g.scorePct, 33.33);
  assert.equal(g.details.find((d) => d.questionId === 'q2').isCorrect, false);
});

test('gradeAttempt : tout juste = 100, tout faux = 0', () => {
  assert.equal(gradeAttempt([single, multi], new Map([['q1', ['b']], ['q2', ['d', 'f']]])).scorePct, 100);
  assert.equal(gradeAttempt([single, multi], new Map()).scorePct, 0);
});

test('checkOptions : règles par type', () => {
  const o = (text, isCorrect) => ({ text, isCorrect });
  assert.equal(checkOptions('single', [o('A', true), o('B', false)]), null);
  assert.match(checkOptions('single', [o('A', true), o('B', true)]), /exactement une/);
  assert.match(checkOptions('single', [o('A', true)]), /entre 2 et 8/);
  assert.match(checkOptions('multiple', [o('A', false), o('B', false)]), /au moins une/);
  assert.equal(checkOptions('multiple', [o('A', true), o('B', true)]), null);
  assert.match(checkOptions('single', [o('A', true), o('a ', false)]), /même texte/);
  assert.equal(checkOptions('true_false', [o('Vrai', true), o('Faux', false)]), null);
  assert.match(checkOptions('true_false', [o('Vrai', true), o('Faux', true)]), /vrai\/faux/);
});

test('vrai/faux : libellés selon la langue, une seule bonne réponse', () => {
  assert.deepEqual(buildTrueFalseOptions(true, 'fr'), [{ text: 'Vrai', isCorrect: true }, { text: 'Faux', isCorrect: false }]);
  assert.deepEqual(buildTrueFalseOptions(false, 'en'), [{ text: 'True', isCorrect: false }, { text: 'False', isCorrect: true }]);
  assert.equal(checkOptions('true_false', buildTrueFalseOptions(true)), null);
});

test('moduleOutcome : compétent seulement si toutes les évaluations obligatoires sont réussies', () => {
  const best = new Map([['a1', 80], ['a2', 60]]);
  assert.deepEqual(moduleOutcome(['a1', 'a2'], new Set(['a1', 'a2']), best), { status: 'competent', scorePct: 70 });
  assert.equal(moduleOutcome(['a1', 'a2'], new Set(['a1']), best).status, 'not_yet');
  assert.equal(moduleOutcome([], new Set(), new Map()).status, 'not_yet');
  assert.equal(moduleOutcome(['a1'], new Set(), new Map()).scorePct, null);
});

test('temps limite : marge de 60 s, pas de limite = jamais expiré', () => {
  const start = new Date('2026-10-17T10:00:00Z');
  const at = (min, extraMs = 0) => start.getTime() + min * 60000 + extraMs;
  assert.equal(isExpired(start, null, at(999)), false);
  assert.equal(isExpired(start, 10, at(10, GRACE_MS - 1)), false);
  assert.equal(isExpired(start, 10, at(10, GRACE_MS + 1)), true);
  assert.equal(deadlineOf(start, null), null);
  assert.equal(deadlineOf(start, 10).toISOString(), '2026-10-17T10:10:00.000Z');
});
