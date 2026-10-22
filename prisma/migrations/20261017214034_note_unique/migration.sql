/*
  Warnings:

  - A unique constraint covering the columns `[user_id,lesson_id]` on the table `notes` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "notes_user_id_lesson_id_idx";

-- CreateIndex
CREATE UNIQUE INDEX "notes_user_id_lesson_id_key" ON "notes"("user_id", "lesson_id");
