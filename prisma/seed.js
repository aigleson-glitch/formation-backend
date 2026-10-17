import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";

const prisma = new PrismaClient();
const hash = (p) => bcrypt.hash(p, 12);

async function main() {
  await prisma.user.upsert({
    where: { email: "admin@example.com" }, update: {},
    create: { email: "admin@example.com", passwordHash: await hash("ChangeMe123!"), firstName: "Admin", lastName: "Plateforme", role: "admin" },
  });
  const teacher = await prisma.user.upsert({
    where: { email: "formateur@example.com" }, update: {},
    create: { email: "formateur@example.com", passwordHash: await hash("ChangeMe123!"), firstName: "Formateur", lastName: "Démo", role: "instructor", canTeachMinors: true },
  });

  const info = await prisma.category.upsert({ where: { slug: "informatique" }, update: { color: "#3f6fd8", icon: "laptop" }, create: { name: "Informatique", slug: "informatique", color: "#3f6fd8", icon: "laptop" } });
  const anglais = await prisma.category.upsert({ where: { slug: "anglais" }, update: { color: "#12b8b0", icon: "languages" }, create: { name: "Anglais", slug: "anglais", color: "#12b8b0", icon: "languages" } });

  const course = await prisma.course.upsert({
    where: { slug: "initiation-informatique" }, update: {},
    create: {
      categoryId: info.id, title: "Initiation à l\u0027informatique", slug: "initiation-informatique",
      description: "Découvrir l\u0027ordinateur pas à pas.", price: 0, isPublished: true, sequentialUnlock: true,
      audiences: { create: [{ ageGroup: "child" }, { ageGroup: "teen" }, { ageGroup: "adult" }] },
      instructors: { create: { userId: teacher.id } },
      modules: { create: [
        { title: "Découvrir l\u0027ordinateur", position: 1, chapters: { create: [
          { title: "Les éléments de base", position: 1, lessons: { create: [
            { title: "Écran, clavier, souris", type: "text", content: "Voici les trois éléments principaux...", position: 1 },
            { title: "Allumer et éteindre", type: "text", content: "Pour allumer l\u0027ordinateur...", position: 2 },
          ] } },
        ] } },
        { title: "Les fichiers et dossiers", position: 2, chapters: { create: [
          { title: "Ranger ses fichiers", position: 1, lessons: { create: [
            { title: "Créer un dossier", type: "text", content: "Clic droit, puis Nouveau dossier.", position: 1 },
          ] } },
        ] } },
      ] },
    },
  });
  console.log("Seed OK :", course.slug);

  // ── Cours d'anglais de démonstration pour l'entraînement oral ──
  const en = await prisma.course.upsert({
    where: { slug: "anglais-a2-experiences" }, update: {},
    create: {
      categoryId: anglais.id, title: "Anglais A2 : parler de ses expériences", slug: "anglais-a2-experiences",
      description: "Apprendre à raconter ce que l\u0027on a déjà fait (present perfect).", language: "en",
      price: 0, isPublished: true,
      audiences: { create: [{ ageGroup: "teen" }, { ageGroup: "adult" }] },
      instructors: { create: { userId: teacher.id } },
      modules: { create: [{ title: "Talking about experiences", position: 1, chapters: { create: [{
        title: "Present perfect : mes expériences", position: 1,
        lessons: { create: [
          { title: "Form of the present perfect", type: "text", position: 1,
            content: "We use have or has + the past participle.\nI have visited Pointe-Noire. She has never seen the sea.\nQuestions: Have you ever eaten fufu?\nNegative: I haven\u0027t called my sister yet." },
          { title: "Present perfect or past simple?", type: "text", position: 2,
            content: "If we say when something happened, we use the past simple: I went to Brazzaville last year.\nIf we do not say when, we use the present perfect: I have been to Brazzaville." },
        ] },
      }] } }] },
    },
  });
  const enChapter = await prisma.chapter.findFirst({ where: { module: { courseId: en.id } } });
  const profile = JSON.parse(readFileSync(new URL("./examples/chapter-profile.example.json", import.meta.url), "utf8"));
  delete profile.chapterId; profile.linkedLessonIds = [];   // les leçons du chapitre sont utilisées automatiquement
  await prisma.chapterAiProfile.upsert({
    where: { chapterId: enChapter.id }, update: { data: profile }, create: { chapterId: enChapter.id, data: profile },
  });
  console.log("Seed OK :", en.slug, "(profil IA du chapitre inclus)");
}

main().finally(() => prisma.$disconnect());
