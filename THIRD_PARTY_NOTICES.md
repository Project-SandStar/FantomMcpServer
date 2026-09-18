# Third-party notices

The Fantom MCP Server is licensed under the Project Sandstar Source-Available
License (PSSL) v1.1 — see [`LICENSE`](./LICENSE). It bundles or depends on the
following third-party components, which remain under their own licenses.

## Bundled in this repository

| Component | Location | License |
|---|---|---|
| Tree-sitter grammars (WebAssembly builds: C, C++, C#, CSS, Dart, Go, HTML, Java, JavaScript, JSON, Kotlin, PHP, Polymer, Python, Ruby, Rust, Scala, TypeScript, Vue) | `src/parser/treeSitter/grammars/*.wasm` | MIT (each upstream `tree-sitter-<lang>` project) |
| tree-sitter-fantom grammar | `tree-sitter-fantom/`, `src/parser/treeSitter/grammars/tree-sitter-fantom.wasm` | PSSL v1.1 (this project) |
| tree-sitter-axon grammar | `tree-sitter-axon/`, `src/parser/treeSitter/grammars/tree-sitter-axon.wasm` | PSSL v1.1 (this project) |
| tree-sitter-xeto grammar | `src/parser/treeSitter/grammars/tree-sitter-xeto.wasm` | PSSL v1.1 (this project) |

The `.wasm` grammars can be regenerated or re-downloaded with
`npm run grammars:download`; their upstream repositories and license texts are
listed in `scripts/download-grammars.ts`.

## Runtime dependencies (installed via npm)

All npm dependencies are declared in `package.json` and `dashboard/package.json`
and are used under their respective licenses (MIT, Apache-2.0, BSD, ISC and
similar). Notable native components:

- `@ladybugdb/core` — embedded graph database (per-project code graphs)
- `@lancedb/lancedb` — embedded vector store
- `@prisma/client` / `prisma` — SQLite ORM
- `@huggingface/transformers` — in-process embedding fallback
- `web-tree-sitter` — parser runtime

Run `npx license-checker --summary` (or your preferred tool) after
`npm install` for the complete list with license texts.

## Trademarks

Fantom is a trademark of Brian and Andy Frank. Haxall and SkySpark are
trademarks of SkyFoundry LLC. Project Haystack is a trademark of Project
Haystack Corporation. This project is not affiliated with or endorsed by any of
them.
