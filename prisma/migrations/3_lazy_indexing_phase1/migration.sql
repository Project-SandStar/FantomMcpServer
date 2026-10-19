-- Lazy indexing phase 1 (docs/proposals/lazy-incremental-indexing.md 3.2.9, 3.3):
-- durable task queue, git roots and the per-(project, root) base commit.
-- Hand-written: plain ADD COLUMN instead of Prisma's table rebuild, so the
-- populated fantom_projects / index_runs tables are never copied or dropped.

-- AlterTable: "git" when a git root owns the project path, "scan" otherwise.
ALTER TABLE "fantom_projects" ADD COLUMN "index_mode" TEXT NOT NULL DEFAULT 'scan';

-- AlterTable: change source and git move of each run.
ALTER TABLE "index_runs" ADD COLUMN "change_source" TEXT;
ALTER TABLE "index_runs" ADD COLUMN "git_from_commit" TEXT;
ALTER TABLE "index_runs" ADD COLUMN "head_move" TEXT;
ALTER TABLE "index_runs" ADD COLUMN "git_dirty" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "index_runs" ADD COLUMN "git_head_time" DATETIME;
ALTER TABLE "index_runs" ADD COLUMN "checkout" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "index_tasks" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "project_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "priority" INTEGER NOT NULL DEFAULT 50,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "dedupe_key" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_run_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" TEXT,
    "lease_until" DATETIME,
    "parent_id" INTEGER,
    "run_id" INTEGER,
    "error" TEXT,
    "result" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" DATETIME,
    "finished_at" DATETIME,
    CONSTRAINT "index_tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "fantom_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "git_roots" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "root" TEXT NOT NULL,
    "git_dir" TEXT NOT NULL,
    "git_common_dir" TEXT NOT NULL,
    "parent_root_id" INTEGER,
    "last_head_seen" TEXT,
    "last_reflog_ident" TEXT,
    "last_head_move" TEXT,
    "hook_installed" BOOLEAN NOT NULL DEFAULT false,
    "hook_token_hash" TEXT,
    "git_error" TEXT,
    "watch_mode" TEXT NOT NULL DEFAULT 'fsevents',
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "git_roots_parent_root_id_fkey" FOREIGN KEY ("parent_root_id") REFERENCES "git_roots" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "project_git_state" (
    "project_id" INTEGER NOT NULL,
    "root_id" INTEGER NOT NULL,
    "sub_path" TEXT NOT NULL DEFAULT '',
    "last_indexed_commit" TEXT,
    "last_indexed_branch" TEXT,
    "dirty_paths" TEXT NOT NULL DEFAULT '[]',
    "last_dirty_at" DATETIME,
    "last_scan_at" DATETIME,
    "updated_at" DATETIME NOT NULL,

    PRIMARY KEY ("project_id", "root_id"),
    CONSTRAINT "project_git_state_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "fantom_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "project_git_state_root_id_fkey" FOREIGN KEY ("root_id") REFERENCES "git_roots" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "index_tasks_dedupe_key_key" ON "index_tasks"("dedupe_key");

-- CreateIndex
CREATE INDEX "index_tasks_state_priority_next_run_at_idx" ON "index_tasks"("state", "priority", "next_run_at");

-- CreateIndex
CREATE INDEX "index_tasks_project_id_kind_state_idx" ON "index_tasks"("project_id", "kind", "state");

-- CreateIndex
CREATE INDEX "index_tasks_created_at_idx" ON "index_tasks"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "git_roots_root_key" ON "git_roots"("root");

-- CreateIndex
CREATE INDEX "git_roots_parent_root_id_idx" ON "git_roots"("parent_root_id");

-- CreateIndex
CREATE INDEX "project_git_state_root_id_idx" ON "project_git_state"("root_id");
