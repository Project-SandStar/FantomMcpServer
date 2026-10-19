-- Lazy indexing phase 2: stable symbol keys (lazy-incremental-indexing.md 3.6, 3.8).
-- Additive only: new columns with defaults and one new table. No data is
-- rewritten. Apply with `npm run db:setup` (prisma migrate deploy) after a
-- copy of .cache/fantom.db. Never migrate dev / migrate reset.

-- Owning git root a file's symbol keys are relative to; '' = the project root.
ALTER TABLE "indexed_files" ADD COLUMN "key_base" TEXT NOT NULL DEFAULT '';

-- Key scheme per project: 1 = legacy ids, 2 = stable keys (set by the rekey
-- task, never set back). rekeyed_at = vector copy finished.
ALTER TABLE "fantom_projects" ADD COLUMN "key_scheme" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "fantom_projects" ADD COLUMN "rekeyed_at" DATETIME;

-- CreateTable
CREATE TABLE "symbol_links" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "project_id" INTEGER NOT NULL,
    "old_key" TEXT NOT NULL,
    "new_key" TEXT NOT NULL,
    "new_node_id" TEXT,
    "kind" TEXT NOT NULL,
    "run_id" INTEGER,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "symbol_links_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "fantom_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "symbol_links_project_id_kind_old_key_key" ON "symbol_links"("project_id", "kind", "old_key");

-- CreateIndex
CREATE INDEX "symbol_links_project_id_new_key_idx" ON "symbol_links"("project_id", "new_key");
