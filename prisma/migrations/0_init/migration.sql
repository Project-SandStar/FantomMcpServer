-- Baseline migration generated from prisma/schema.prisma (prisma migrate diff --from-empty).
-- The historical incremental migrations were replaced by this baseline for the public
-- release: they lagged the schema by ~90 columns and one of them (a view with a bind
-- parameter) could not be applied to a fresh SQLite database.
-- FTS5 virtual tables are created at runtime by src/search/fts5Setup.ts when enabled.

-- CreateTable
CREATE TABLE "instances" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'fantom',
    "version" TEXT,
    "fan_executable" TEXT,
    "description" TEXT,
    "source_path" TEXT,
    "fantom_version" TEXT,
    "fantom_source_path" TEXT,
    "is_valid" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "doc_source_instance_id" INTEGER,
    CONSTRAINT "instances_doc_source_instance_id_fkey" FOREIGN KEY ("doc_source_instance_id") REFERENCES "instances" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "fantom_builds" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "version" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "has_source" BOOLEAN NOT NULL DEFAULT false,
    "pod_count" INTEGER NOT NULL DEFAULT 0,
    "function_count" INTEGER NOT NULL DEFAULT 0,
    "type_count" INTEGER NOT NULL DEFAULT 0,
    "last_indexed" DATETIME,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "pods" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "build_file" TEXT NOT NULL DEFAULT 'build.fan',
    "description" TEXT,
    "default_instance_id" INTEGER,
    "compat_min_version" TEXT,
    "compat_max_version" TEXT,
    "compat_versions" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "pods_default_instance_id_fkey" FOREIGN KEY ("default_instance_id") REFERENCES "instances" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "compile_logs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "pod_id" INTEGER NOT NULL,
    "instance_id" INTEGER NOT NULL,
    "build_file" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "output" TEXT,
    "error" TEXT,
    "duration_ms" INTEGER,
    "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" DATETIME,
    CONSTRAINT "compile_logs_pod_id_fkey" FOREIGN KEY ("pod_id") REFERENCES "pods" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "compile_logs_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "instances" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "fantom_projects" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "instance_id" INTEGER,
    "build_id" INTEGER,
    "pod_name" TEXT,
    "description" TEXT,
    "function_count" INTEGER NOT NULL DEFAULT 0,
    "type_count" INTEGER NOT NULL DEFAULT 0,
    "last_indexed" DATETIME,
    "auto_index" BOOLEAN NOT NULL DEFAULT true,
    "language" TEXT NOT NULL DEFAULT 'fantom',
    "parserType" TEXT NOT NULL DEFAULT 'regex',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "fantom_projects_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "instances" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "fantom_projects_build_id_fkey" FOREIGN KEY ("build_id") REFERENCES "fantom_builds" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "indexed_files" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "project_id" INTEGER NOT NULL,
    "file_path" TEXT NOT NULL,
    "mtime_ms" BIGINT NOT NULL,
    "content_sha256" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "symbol_count" INTEGER NOT NULL DEFAULT 0,
    "indexed_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "indexed_files_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "fantom_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "index_runs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "project_id" INTEGER NOT NULL,
    "started_at" DATETIME NOT NULL,
    "finished_at" DATETIME,
    "trigger" TEXT NOT NULL,
    "files_scanned" INTEGER NOT NULL DEFAULT 0,
    "files_parsed" INTEGER NOT NULL DEFAULT 0,
    "files_skipped" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "added_count" INTEGER NOT NULL DEFAULT 0,
    "modified_count" INTEGER NOT NULL DEFAULT 0,
    "removed_count" INTEGER NOT NULL DEFAULT 0,
    "is_seeding_run" BOOLEAN NOT NULL DEFAULT false,
    "force" BOOLEAN NOT NULL DEFAULT false,
    "error_message" TEXT,
    "git_commit" TEXT,
    "git_branch" TEXT,
    CONSTRAINT "index_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "fantom_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "api_changes" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "run_id" INTEGER NOT NULL,
    "project_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "qualified_name" TEXT NOT NULL,
    "change_type" TEXT NOT NULL,
    "before_sig" TEXT,
    "after_sig" TEXT,
    "file_path" TEXT NOT NULL,
    "line_start" INTEGER,
    "line_end" INTEGER,
    "occurred_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "api_changes_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "index_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "edge_changes" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "run_id" INTEGER NOT NULL,
    "project_id" INTEGER NOT NULL,
    "source_qn" TEXT NOT NULL,
    "target_qn" TEXT NOT NULL,
    "edge_type" TEXT NOT NULL,
    "change_type" TEXT NOT NULL,
    "occurred_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "edge_changes_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "index_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "cross_project_edges" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "source_id" TEXT NOT NULL,
    "source_project_id" INTEGER NOT NULL,
    "source_qn" TEXT NOT NULL,
    "source_language" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "target_project_id" INTEGER NOT NULL,
    "target_qn" TEXT NOT NULL,
    "target_language" TEXT NOT NULL,
    "edge_type" TEXT NOT NULL,
    "line_number" INTEGER,
    "confidence" REAL NOT NULL DEFAULT 0.7,
    "resolved_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "doc_indexes" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "instance_id" INTEGER NOT NULL,
    "pod_name" TEXT NOT NULL,
    "doc_path" TEXT NOT NULL,
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "version" TEXT,
    "last_indexed" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cache_file" TEXT,
    CONSTRAINT "doc_indexes_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "instances" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "tool_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tool_name" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duration_ms" INTEGER,
    "success" BOOLEAN NOT NULL,
    "error_message" TEXT,
    "session_id" TEXT
);

-- CreateTable
CREATE TABLE "search_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "query" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "result_count" INTEGER NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "session_id" TEXT
);

-- CreateTable
CREATE TABLE "oauth_clients" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "client_id" TEXT NOT NULL,
    "client_secret" TEXT,
    "client_name" TEXT,
    "redirect_uris" TEXT NOT NULL,
    "scope" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "authorization_codes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT,
    "redirect_uri" TEXT NOT NULL,
    "scope" TEXT,
    "code_challenge" TEXT NOT NULL,
    "code_challenge_method" TEXT NOT NULL DEFAULT 'S256',
    "expires_at" DATETIME NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "authorization_codes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients" ("client_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "access_tokens" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT,
    "scope" TEXT,
    "expires_at" DATETIME NOT NULL,
    "revoked_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "access_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients" ("client_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT,
    "scope" TEXT,
    "expires_at" DATETIME NOT NULL,
    "revoked_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "refresh_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients" ("client_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "oauth_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_name" TEXT,
    "user_id" TEXT,
    "scope" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_agent" TEXT,
    "ip_address" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "instances_name_key" ON "instances"("name");

-- CreateIndex
CREATE UNIQUE INDEX "fantom_builds_version_key" ON "fantom_builds"("version");

-- CreateIndex
CREATE UNIQUE INDEX "pods_path_build_file_key" ON "pods"("path", "build_file");

-- CreateIndex
CREATE UNIQUE INDEX "fantom_projects_name_key" ON "fantom_projects"("name");

-- CreateIndex
CREATE INDEX "indexed_files_project_id_idx" ON "indexed_files"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "indexed_files_project_id_file_path_key" ON "indexed_files"("project_id", "file_path");

-- CreateIndex
CREATE INDEX "index_runs_project_id_started_at_idx" ON "index_runs"("project_id", "started_at");

-- CreateIndex
CREATE INDEX "api_changes_project_id_occurred_at_idx" ON "api_changes"("project_id", "occurred_at");

-- CreateIndex
CREATE INDEX "api_changes_qualified_name_idx" ON "api_changes"("qualified_name");

-- CreateIndex
CREATE INDEX "api_changes_run_id_idx" ON "api_changes"("run_id");

-- CreateIndex
CREATE INDEX "edge_changes_project_id_occurred_at_idx" ON "edge_changes"("project_id", "occurred_at");

-- CreateIndex
CREATE INDEX "edge_changes_source_qn_idx" ON "edge_changes"("source_qn");

-- CreateIndex
CREATE INDEX "edge_changes_target_qn_idx" ON "edge_changes"("target_qn");

-- CreateIndex
CREATE INDEX "edge_changes_run_id_idx" ON "edge_changes"("run_id");

-- CreateIndex
CREATE INDEX "cross_project_edges_source_project_id_idx" ON "cross_project_edges"("source_project_id");

-- CreateIndex
CREATE INDEX "cross_project_edges_target_project_id_idx" ON "cross_project_edges"("target_project_id");

-- CreateIndex
CREATE INDEX "cross_project_edges_source_qn_idx" ON "cross_project_edges"("source_qn");

-- CreateIndex
CREATE INDEX "cross_project_edges_target_qn_idx" ON "cross_project_edges"("target_qn");

-- CreateIndex
CREATE INDEX "cross_project_edges_edge_type_idx" ON "cross_project_edges"("edge_type");

-- CreateIndex
CREATE UNIQUE INDEX "cross_project_edges_source_id_target_id_edge_type_key" ON "cross_project_edges"("source_id", "target_id", "edge_type");

-- CreateIndex
CREATE UNIQUE INDEX "doc_indexes_instance_id_pod_name_key" ON "doc_indexes"("instance_id", "pod_name");

-- CreateIndex
CREATE INDEX "tool_events_tool_name_idx" ON "tool_events"("tool_name");

-- CreateIndex
CREATE INDEX "tool_events_timestamp_idx" ON "tool_events"("timestamp");

-- CreateIndex
CREATE INDEX "search_events_source_idx" ON "search_events"("source");

-- CreateIndex
CREATE INDEX "search_events_timestamp_idx" ON "search_events"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_clients_client_id_key" ON "oauth_clients"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "authorization_codes_code_key" ON "authorization_codes"("code");

-- CreateIndex
CREATE INDEX "authorization_codes_code_idx" ON "authorization_codes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "access_tokens_token_key" ON "access_tokens"("token");

-- CreateIndex
CREATE INDEX "access_tokens_token_idx" ON "access_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_key" ON "refresh_tokens"("token");

-- CreateIndex
CREATE INDEX "refresh_tokens_token_idx" ON "refresh_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_sessions_session_id_key" ON "oauth_sessions"("session_id");

-- CreateIndex
CREATE INDEX "oauth_sessions_client_id_idx" ON "oauth_sessions"("client_id");

