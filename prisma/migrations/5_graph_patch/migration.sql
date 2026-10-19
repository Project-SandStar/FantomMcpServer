-- Lazy indexing phase 3: file-level graph patch (lazy-incremental-indexing.md 3.4).
-- Additive only: one new table. No data is rewritten. Apply with
-- `npm run db:setup` (prisma migrate deploy) after a copy of .cache/fantom.db.
-- Never migrate dev / migrate reset.

-- Outgoing references whose target is not in the graph yet. The graph patch
-- re-resolves them when a parse adds a symbol with a matching name, and
-- turns the incoming edges of a deleted symbol into rows here, so the edge
-- comes back when the symbol does. Bounded per project (oldest rows first).
-- CreateTable
CREATE TABLE "pending_refs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "project_id" INTEGER NOT NULL,
    "source_file" TEXT NOT NULL,
    "source_key" TEXT NOT NULL DEFAULT '',
    "source_id" TEXT NOT NULL,
    "target_name" TEXT NOT NULL,
    "target_tail" TEXT NOT NULL,
    "edge_type" TEXT NOT NULL,
    "line" INTEGER NOT NULL DEFAULT 0,
    "col" INTEGER NOT NULL DEFAULT 0,
    "confidence" REAL NOT NULL DEFAULT 1.0,
    "class_name" TEXT NOT NULL DEFAULT '',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pending_refs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "fantom_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "pending_refs_project_id_source_file_idx" ON "pending_refs"("project_id", "source_file");

-- CreateIndex
CREATE INDEX "pending_refs_project_id_target_tail_idx" ON "pending_refs"("project_id", "target_tail");
