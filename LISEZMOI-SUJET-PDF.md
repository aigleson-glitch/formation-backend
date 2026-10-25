# Sujet PDF joint aux devoirs (testé : 54 tests + 5 parcours)

## Installation
1. Commite l'état actuel si besoin, puis **arrête l'API** (Ctrl+C) : Windows peut verrouiller des fichiers pendant la mise à jour du client Prisma.
2. Copie le contenu de ce zip dans `backend` en remplaçant les fichiers (existants : `prisma/schema.prisma`, `src/routes/assignment.js`, `src/routes/studioAssignment.js`, `src/lib/assignmentRules.js`, `scripts/smoke-assignments.mjs`, `test/assignmentRules.test.js`).
3. Applique la migration : `npx prisma migrate dev`  (elle ajoute 2 colonnes facultatives à `assessments` et régénère le client ; aucune donnée existante n'est touchée).
4. Relance `npm run dev`, puis `npm test` (54 tests) et `npm run smoke:assignments`.

## Fonctionnement
- À la création ou à la modification d'un devoir, le formateur peut indiquer `attachmentUrl` (lien **https** du PDF) et `attachmentName` (nom affiché, facultatif) :
  `POST /studio/modules/:id/assignments  { "title": "...", "attachmentUrl": "https://.../sujet.pdf", "attachmentName": "Sujet du devoir 2" }`
  `PATCH /studio/assignments/:id  { "attachmentUrl": null }` retire le sujet (et son nom).
- L'élève le voit dans la fiche du devoir : `GET /assignments/:id` → `attachment: { url, name }` (ou `null`). L'interface affichera le bouton « Télécharger le sujet ».
- Ces devoirs se corrigent à la main par le formateur (file de correction, note, commentaire), comme tous les devoirs.
- Le sujet reste modifiable même après des remises (correction d'une faute) ; le seuil de réussite, lui, ne change plus.

## Pas encore couvert
Le **téléversement** d'un fichier PDF (par le formateur pour le sujet, par l'élève pour sa copie) : il faut d'abord choisir où stocker les fichiers (disque du serveur ou service de type S3). Le champ ajouté ici servira alors de même.
