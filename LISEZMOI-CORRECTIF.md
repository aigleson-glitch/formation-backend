# Correctif backend v2 (testé sur ton dépôt, commit dd79884)

## Installation
1. Ton travail est déjà commité. Copie le contenu de ce zip dans ton dossier `backend`, en remplaçant les fichiers.
2. `package.json` est fourni : il ajoute seulement le script `smoke:staff`.
3. Aucune migration, aucun `npm install`. `progress.js`, `learn.js`, `quiz.js`, `studioQuiz.js` et `schema.prisma` ne sont pas touchés.
4. Relance `npm run dev`, puis : `npm test`, `npm run smoke:quiz`, `npm run smoke:notes`, `npm run smoke:staff`.
5. Si tout va bien : `git add -A` puis `git commit -m "Admin, éditeur formateur, sécurité"`.

## Ce qui change
- **Administration** (`/admin`) : création et gestion des formateurs et admins.
- **Règle « mineurs »** : formations enfants/ados réservées aux formateurs habilités ; publication refusée sans formateur habilité ; affectation par l'admin.
- **Éditeur formateur** : arbre complet, renommer/supprimer/réordonner modules, chapitres, leçons (suppression bloquée si des élèves sont inscrits).
- **Sécurité** : jeton HS256 épinglé, connexion à temps constant, CORS nettoyé, démarrage refusé en production si `JWT_SECRET` < 32 caractères ou `CORS_ORIGIN` vide, seed interdit en production.
- **Quiz vide** : ton comportement est conservé (un quiz obligatoire ajouté après coup verrouille le module jusqu'à ce qu'il ait des questions). L'arbre du formateur signale ces quiz (`playable: false`).

## Premier administrateur en production
    $env:ADMIN_PASSWORD = "un mot de passe long et unique"
    node scripts/create-admin.mjs prenom.nom@exemple.com Prénom Nom

## Production
`NODE_ENV=production`, `JWT_SECRET` (≥ 32 car.), `CORS_ORIGIN=https://ton-site.fr`, conseillé : `JWT_EXPIRES_IN=12h`.
