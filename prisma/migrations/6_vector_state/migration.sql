-- Lazy indexing phase 4: incremental embedding (lazy-incremental-indexing.md 3.5).
-- Additive only: one new table. No data is rewritten. Apply with
-- `npm run db:setup` (prisma migrate deploy) after a copy of .cache/fantom.db.
-- Never migrate dev / migrate reset.

-- What text each code_vectors node was embedded from. Same hash + version +
-- model = no embed; a row no node claims is an orphan (embedPatch, vector-gc).
-- CreateTable
CREATE TABLE "vector_state" (
    "node_id" TEXT NOT NULL PRIMARY KEY,
    "project_id" INTEGER NOT NULL,
    "file_path" TEXT NOT NULL,
    "qualified_name" TEXT NOT NULL DEFAULT '',
    "symbol_key" TEXT NOT NULL DEFAULT '',
    "body_sha" TEXT NOT NULL DEFAULT '',
    "text_hash" TEXT NOT NULL,
    "text_version" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "chunk_count" INTEGER NOT NULL DEFAULT 1,
    "embedded_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "run_id" INTEGER,
    CONSTRAINT "vector_state_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "fantom_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "vector_state_project_id_file_path_idx" ON "vector_state"("project_id", "file_path");

-- CreateIndex
CREATE INDEX "vector_state_project_id_body_sha_idx" ON "vector_state"("project_id", "body_sha");

-- CreateIndex
CREATE INDEX "vector_state_project_id_text_hash_idx" ON "vector_state"("project_id", "text_hash");
