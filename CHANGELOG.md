# Changelog

All notable changes to FantomMcpServer. Public releases are snapshots; see
`scripts/release-public.sh`.

## 1.0.1 — 2026-09-19

### Parsing
- **Trio files are parsed with a real grammar.** A new `tree-sitter-trio`
  grammar (`tree-sitter-trio/`, wasm vendored under
  `src/parser/treeSitter/grammars/`) replaces the hand-written line loop in
  `TrioParser`. Every record and tag now carries its exact line number, so
  function, view, subview and call line numbers in `.trio` files are real
  instead of estimated. `Zinc:`, `Trio:`, `[` and `{` blocks, nested `Trio:`
  records, comments and separators follow haxall's `TrioReader`. Malformed
  lines are reported as parse warnings instead of silently shifting every
  later record. Axon `src:` bodies are still handed to the Axon grammar; their
  call line numbers are now shifted to file lines.
- Grammar fixes found by running the new reader against the old one over
  3401 real `.trio` files (3398 parse clean, symbol counts identical):
  an indented block that ends the file without a trailing newline keeps its
  body; quoted strings may span lines (SkySpark project exports write `help:`
  and `src:` that way); CRLF files keep no carriage return in names or
  values.
- **Fantom grammar:** `try`, `catch` and `finally` accept a single statement
  without braces, as the language does. Files that used the brace-less form
  produced ERROR nodes and lost the definitions that followed; verified over
  8025 `.fan` files with no regressions.
- `trio` is registered as an indexer language (registry mappings, grammar
  list, file-extension detection).

### Indexing
- A project reindex reports `success: false` only for hard parse errors.
  Warnings (for example a `key=value` config file that happens to be named
  `.trio`) are returned as a separate `warnings` count.

### Tooling
- `ast-grep` configuration (`sgconfig.yml`, rules in `.ast-grep/rules`) with
  the in-repo Fantom, Axon, Xeto and Trio grammars registered as custom
  languages. `ast-grep run -l axon` also searches `src:` blocks inside `.trio`
  files through a language injection.
- Sidecar WebSocket diagnostics: per-agent close counters and tunnel-fault
  state in the WS status, a `ws-probe` admin route, per-message deflate.
- `scripts/release-public.sh` audits with POSIX ERE (BSD `grep` has no `-P`;
  the forbidden-files check used to pass silently) and takes the release
  notes for a version from this file.

## 1.0.0 — 2026-09-18

First public snapshot release.
