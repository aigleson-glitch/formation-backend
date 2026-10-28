-- CreateTable
CREATE TABLE "submission_files" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "assessment_id" UUID NOT NULL,
    "submission_id" UUID,
    "original_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "submission_files_submission_id_key" ON "submission_files"("submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "submission_files_storage_key_key" ON "submission_files"("storage_key");

-- CreateIndex
CREATE INDEX "submission_files_owner_id_idx" ON "submission_files"("owner_id");

-- CreateIndex
CREATE INDEX "submission_files_created_at_idx" ON "submission_files"("created_at");

-- AddForeignKey
ALTER TABLE "submission_files" ADD CONSTRAINT "submission_files_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_files" ADD CONSTRAINT "submission_files_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
