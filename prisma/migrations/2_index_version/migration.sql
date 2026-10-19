-- Lazy indexing phase 0: record which parser/extractor version produced each
-- indexed file, so a parser change re-parses only the affected file types.
-- '' = indexed before this column existed (treated as a version miss).
ALTER TABLE "indexed_files" ADD COLUMN "index_version" TEXT NOT NULL DEFAULT '';

-- PARSER_SCHEMA_VERSION in effect for the run (NULL = before phase 0).
ALTER TABLE "index_runs" ADD COLUMN "parser_version" INTEGER;
