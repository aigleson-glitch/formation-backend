# API Plateforme de formation — Phase 1

Authentification, rôles, groupes d’âge, comptes parent/enfant, catalogue filtré, lecteur de leçon, progression, notes, éditeur formateur.

## Démarrage
```bash
cp .env.example .env      # puis renseigner DATABASE_URL et JWT_SECRET
npm install
npx prisma migrate dev --name init
npm run db:seed           # admin@example.com / formateur@example.com (mot de passe ChangeMe123!)
npm run dev
npm test
```

Le schéma actif de cette API est `prisma/schema.prisma` ; les migrations correspondantes sont dans `prisma/migrations`.

## Endpoints principaux
| Méthode | Route | Rôle |
|---|---|---|
| POST | /auth/register | public (adulte, ado, parent) |
| POST | /auth/login | public (e-mail ou identifiant enfant) |
| GET | /auth/me | connecté |
| GET/POST | /parent/children | parent |
| POST | /parent/guardianships/:id/consent \| revoke | parent |
| GET | /parent/children/:id/progress | parent (lecture seule) |
| GET | /categories, /courses, /courses/:slug | public, filtré par groupe |
| POST | /courses/:id/enroll | apprenant, ou parent avec `forChildId` |
| GET | /my/enrollments, /my/enrollments/:id/continue, /my/notes | connecté |
| GET | /lessons/:id | inscrit + payé |
| POST/DELETE | /lessons/:id/complete | inscrit |
| PUT | /lessons/:id/note | inscrit |
| */studio/... | formateur, admin |

## Oral IA : espace entraînement
Ajoute deux clés dans `.env` : `OPENAI_API_KEY` (Whisper) et `ANTHROPIC_API_KEY` (tuteur). Après `git pull` ou remplacement du dossier : `npx prisma migrate dev --name oral_ai_practice` puis `npm run db:seed` (crée le cours « Anglais A2 » et son profil).

| Méthode | Route | Rôle |
|---|---|---|
| GET | /practice/chapters | apprenant : chapitres entraînables |
| POST | /practice/start `{ chapterId, focus? }` | apprenant : démarre une séance, renvoie la 1re question |
| POST | /practice/:id/answer | apprenant : corps = audio brut (`Content-Type: audio/webm`…), renvoie transcription + retour |
| POST | /practice/:id/next | apprenant : question suivante |
| GET/PUT/DELETE | /studio/chapters/:id/ai-profile | formateur, admin : profil IA du chapitre (JSON validé) |

Garanties : aucune note n'est jamais renvoyée (contrôle serveur + relance), l'audio n'est pas conservé chez nous (il est transmis à OpenAI pour la transcription : à indiquer dans la politique de confidentialité et le consentement parental), les séances expirent après 24 h et sont purgées chaque heure, limites par heure et par étudiant : 20 démarrages, 40 questions suivantes, 40 réponses.

Tutelle parentale : elle prend fin automatiquement au 18e anniversaire de l'enfant (le parent n'a plus accès à son compte).

## Phase 2 : quiz et QCM
Types de questions : choix unique (`single`), choix multiple (`multiple`, tout ou rien) et vrai/faux (`true_false`).

**Formateur** (préfixe `/studio`) : `POST /modules/:id/assessments`, `GET|PATCH|DELETE /assessments/:id`,
`POST /assessments/:id/questions`, `PATCH|DELETE /questions/:id`.
Dès qu'un élève a commencé un quiz, sa structure est figée (seuls les textes et explications restent modifiables).
La publication d'une formation est refusée si un quiz n'a aucune question.

**Élève** : `GET /assessments/:id` (fiche, tentatives restantes), `POST /assessments/:id/attempts` (démarrer ou reprendre),
`POST /attempts/:id/submit` (`{ "answers": [{ "questionId", "optionIds": [] }] }`), `GET /attempts/:id` (reprise ou correction).
La notation est faite côté serveur. Avant la soumission, ni bonnes réponses ni explications ne sont envoyées ;
après, l'élève reçoit sa note, les bonnes réponses et les explications. Un module devient « compétent » quand toutes ses
évaluations obligatoires sont réussies, ce qui débloque le module suivant. Temps limite : 60 s de marge, puis la tentative est close à 0 %.

Test de bout en bout (crée une formation de test non publiée et un apprenant de test) : `node scripts/smoke-quiz.mjs`

## Hors phases 1 et 2 (à venir)
Devoirs (3), paiement et expiration à 48 h (4), certificats (5).
