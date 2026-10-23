# Phase 3 — Devoirs (testée sur ton dépôt + correctif v2)

## Installation
1. Commite d'abord l'état actuel (`git add -A` puis `git commit`).
2. Copie le contenu de ce zip dans `backend` en remplaçant les fichiers (seul `src/app.js` existe déjà).
3. Dans `package.json`, section `"scripts"`, ajoute : `"smoke:assignments": "node scripts/smoke-assignments.mjs"`
4. Aucune migration : la colonne `content` que tu as ajoutée à `Submission` suffit. Aucun `npm install`.
5. Relance l'API, puis : `npm test` (49 tests), `npm run smoke:quiz`, `smoke:notes`, `smoke:staff`, `smoke:assignments`.
   Astuce : l'API limite à 20 inscriptions par heure et par adresse ; si un test répond « Trop de tentatives », redémarre l'API.

## Parcours
**Élève** : `GET /assignments/:id` (fiche, mes copies, remise possible ou non) · `POST /assignments/:id/submissions` `{ content?, linkUrl? }` (texte et/ou lien https).
**Formateur** : `POST /studio/modules/:id/assignments` (+ `GET/PATCH/DELETE /studio/assignments/:id`) · `GET /studio/submissions?status=open|submitted|in_review|graded|resubmit&courseId&page` (file de correction) · `GET /studio/submissions/:id` · `POST /studio/submissions/:id/start-review` · `POST /studio/submissions/:id/grade` `{ decision: "graded"|"resubmit", scorePct?, feedback }`.
**Parent** : `GET /parent/children/:childId/submissions` (lecture seule).

## Règles
- Statuts : Soumis → En correction → Corrigé, ou À resoumettre. Note et commentaire visibles par l'élève seulement après correction.
- Le formateur doit toujours écrire un commentaire ; une note de 0 à 100 est exigée pour « corrigé ». Réussi si note ≥ seuil.
- Une copie « à resoumettre » ne consomme pas de tentative ; une copie corrigée et ratée, si. Pas de nouvelle remise tant qu'une copie attend sa correction, ni après réussite.
- Une correction se révise tant que c'est la dernière copie de l'élève : le module (et la fin de formation) sont recalculés.
- Un devoir déjà rendu ne se supprime plus et son seuil ne change plus. Les devoirs ne se modifient que par `/studio/assignments`, pas par les routes de quiz.
- Un formateur ne voit que les copies de ses formations ; l'admin voit tout.

## Pas encore couvert
Dépôt de fichiers (PDF, ZIP, image) : il faut un stockage (S3 ou équivalent). Pour l'instant : texte + lien https.
E-mail de notification à la correction : en attente du système d'e-mails.
