# Certificats (testés sur ton dépôt, commit a5bbfed)

## Installation
1. Commite d'abord l'état actuel si besoin.
2. Copie le contenu de ce zip dans `backend` en remplaçant les fichiers (existants : `src/app.js` et `src/lib/progress.js`).
3. Ajoute dans `package.json` : `"smoke:certificates": "node scripts/smoke-certificates.mjs"`
   (commande : `node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.scripts['smoke:certificates']='node scripts/smoke-certificates.mjs';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"`)
4. Aucune migration (la table `certificates` existe), aucun `npm install`.
5. Redémarre l'API, puis `npm test` (53 tests) et les 5 `smoke:*`.

## Fonctionnement
- **Émission automatique** : au moment où l'inscription passe à « terminée » (tous les modules compétents ET toutes les leçons faites), un certificat est créé avec un code `CERT-XXXX-XXXX-XXXX` (12 caractères aléatoires, sans 0/O/1/I/L).
- **Rattrapage** : une formation terminée avant cette mise à jour reçoit son certificat à la première consultation de « Mes certificats ».
- **Élève** : `GET /my/certificates` (liste) · `GET /my/certificates/:code` (fiche à afficher et imprimer : titulaire, formation, dates, émetteur, lien de vérification).
- **Parent** : `GET /parent/children/:childId/certificates` (lecture seule).
- **Vérification publique, sans connexion** : `GET /certificates/verify/:code` → `{ valid, holder, course, issuedAt, issuer }`. Saisie tolérante (minuscules, espaces). Limitée à 30 vérifications par minute et par adresse.
- **Vie privée** : sur la page publique, le nom complet n'apparaît que pour un adulte ; un enfant ou un ado apparaît avec son prénom et l'initiale de son nom (« Petit M. »). Jamais d'e-mail, d'identifiant ni de date de naissance.

## Réglages facultatifs (.env)
- `CERTIFICATE_ISSUER_NAME` : nom de l'organisme affiché (défaut : « Plateforme de formation »).
- `CERTIFICATE_VERIFY_BASE_URL` : adresse de la page de vérification de ton site, ex. `https://monsite.com/verification` ; le certificat renvoie alors `verifyUrl` = adresse + code, à mettre dans le QR code.

## Pas encore couvert
Fichier PDF généré par l'API (l'interface web affiche et imprime), envoi par e-mail, révocation d'un certificat, nom figé au moment de l'émission (le nom affiché suit le profil).
