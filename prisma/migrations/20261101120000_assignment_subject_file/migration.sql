-- AlterTable : sujet d'un devoir téléversé par le formateur (en plus ou à la place du lien https)
ALTER TABLE "assessments" ADD COLUMN "attachment_key" TEXT,
ADD COLUMN "attachment_mime" TEXT,
ADD COLUMN "attachment_size" INTEGER;
