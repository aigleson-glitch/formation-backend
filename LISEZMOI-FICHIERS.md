# Fichiers joints aux copies (testé sur PostgreSQL : 65 tests + 6 parcours)

Prérequis : la migration `submission_files` (ton `schema-fichiers.prisma`) est appliquée (`npx prisma migrate dev --name submission_files`). Ce zip ne contient ni schéma ni migration.

## Installation
1. Commite l'état actuel (`git status` doit être propre), puis arrête l'API (Ctrl+C).
2. Copie le contenu de ce zip dans `backend` en remplaçant les fichiers.
3. Branche les routes (2 lignes dans `src/app.js` + `.gitignore`, sans rien écraser) :
   `node scripts/install-files.mjs`
4. Ajoute le script de test :
   `node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.scripts['smoke:files']='node scripts/smoke-files.mjs';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"`
5. Contrôle : `git status` ne doit lister comme « modified » que : `.gitignore`, `src/app.js`, `src/lib/assignmentRules.js`, `src/routes/assignment.js`, `src/routes/studioAssignment.js`, `src/routes/parentSubmissions.js`. Vérifie avec `git --no-pager diff --stat` : ces fichiers ne doivent presque avoir que des lignes ajoutées.
6. Relance `npm run dev`, puis `npm test` (65 tests) et `npm run smoke:files`, `smoke:assignments`.

## Fonctionnement
- **Envoi** : `PUT /assignments/:id/files`, corps = le fichier brut (`Content-Type: application/octet-stream`), en-tête `X-File-Name` = `encodeURIComponent(nom)`. Réponse : `{ id, name, mimeType, sizeBytes }`.
- **Remise** : `POST /assignments/:id/submissions { fileId, content?, linkUrl? }` : le fichier seul suffit.
- **Téléchargement** : `GET /files/:id` (avec le jeton). Toujours en pièce jointe.
- **Retrait d'un brouillon** : `DELETE /files/:id` (tant que le fichier n'est pas rendu).
- Les fiches de copie (élève, formateur, parent) contiennent `file: { id, name, mimeType, sizeBytes }` ; la file du formateur contient `hasFile`.

## Règles de sécurité
- Types acceptés : PDF, Word (.doc, .docx), PNG, JPEG, ZIP. Le type est lu **dans le contenu** : un « .pdf » qui n'en est pas un est refusé ; HTML, SVG, exécutables, tableurs sont refusés.
- Taille maximale : 10 Mo (réglable : `MAX_UPLOAD_MB`). 5 fichiers en attente au plus par élève et par devoir. 30 envois par 10 minutes.
- Droits d'envoi vérifiés avant de lire le fichier : inscrit, module débloqué, remise possible.
- Téléchargement : le propriétaire ; pour un fichier rendu, aussi le formateur du cours, l'administrateur et le parent actif. Dans tous les autres cas : 404.
- Sur le disque : nom aléatoire, jamais le nom de l'utilisateur ; droits 600 ; jamais servi en ligne (`attachment` + `nosniff`).
- Un fichier envoyé mais jamais rendu est supprimé au bout de 24 h.

## À savoir avant la mise en ligne
- Dossier des envois : `uploads/` à côté de `package.json` (réglable : `UPLOAD_DIR`). Sur un hébergeur qui efface le disque à chaque déploiement, il faut un disque persistant ou un stockage externe (S3) : tout passe par `src/lib/fileStore.js` (4 fonctions à remplacer).
- Pas d'analyse antivirus : les fichiers ne sont jamais exécutés et se téléchargent en pièce jointe, mais prévois une analyse (ex. ClamAV) pour de vrais utilisateurs.
- Sauvegarder `uploads/` en même temps que la base.
- Pas encore couvert : fichier PDF du **sujet** déposé par le formateur (aujourd'hui : lien https), dépôt de plusieurs fichiers par copie.
