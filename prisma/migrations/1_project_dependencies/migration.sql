-- AlterTable
ALTER TABLE "fantom_projects" ADD COLUMN "libraries" TEXT;
ALTER TABLE "fantom_projects" ADD COLUMN "summary" TEXT;

-- CreateTable
CREATE TABLE "project_dependencies" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "from_project_id" INTEGER NOT NULL,
    "to_project_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT,
    "confidence" REAL NOT NULL DEFAULT 1.0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "project_dependencies_from_project_id_fkey" FOREIGN KEY ("from_project_id") REFERENCES "fantom_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "project_dependencies_to_project_id_fkey" FOREIGN KEY ("to_project_id") REFERENCES "fantom_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "project_dependencies_to_project_id_idx" ON "project_dependencies"("to_project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_dependencies_from_project_id_to_project_id_kind_key" ON "project_dependencies"("from_project_id", "to_project_id", "kind");
