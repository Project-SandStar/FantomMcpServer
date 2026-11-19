# tree-sitter-axon corpus status

Goal: parse every real Axon file with zero `ERROR` and zero `MISSING` nodes.
Gate: 100% clean files on both corpus parts, after excluding files the Haxall Axon
parser itself rejects.

## Measure

```bash
cd tree-sitter-axon && tree-sitter generate && tree-sitter build --wasm && tree-sitter test --wasm
S=/private/tmp/claude-501/-Users-alper-Code-mcpfantom/49d9dc3d-e274-4367-87b1-2843bd9057a3/scratchpad
node scripts/axon-grammar-corpus.mjs --top 30 axon=$S/corpus-axon.txt trio-src=$S/axon-src-blocks
```

`scripts/axon-grammar-corpus.mjs` is the web-tree-sitter counter from the Fantom work,
defaulting to `tree-sitter-axon/tree-sitter-axon.wasm` (`--wasm <path>` overrides).

Corpus parts:

| part | files | source |
|---|---|---|
| axon | 3506 (3492 after 14 paths under a deleted git worktree were dropped) | every `*.axon` under ~/haxall/haxall-4.0.4 and ~/Code, minus node_modules/.git/build/out/tree-sitter-*/test, deduped by content hash (17147 files, 3506 unique) |
| trio-src | 1146 | `src:` blocks of `func` records in every `*.trio` under the same roots (2570 blocks, 1146 unique), one file per block under `$S/axon-src-blocks/` |

Oracle: `$S/AxonCheck.fan`, a 30-line Fantom script run with
`~/skyspark/skyspark-3.1.12/bin/fan`. It feeds the file to
`axon::Parser.parseTop`, then `Parser.parse`, and prints `OK` or the `SyntaxErr`.
The Axon shell (`bin/axon`) is not usable as an oracle: it wraps multi-line input in
`do ... end`, which rejects every top-level `defcomp`.

Second oracle (2026-11-12): the live SkySpark 3.1.6 `parseAst` through the axon MCP server
(`executeAxonCode`, project calinos/calinos, read-only), called as
`try do parseAst(<src>); "ok" end catch (e) e->dis`. `$S/mk-batches.mjs` turns a list of
files into batches of escaped string literals. Used for the 20 exclusions below (all 20
rejected, same error kinds as the local oracle) and for a random sample of 50 clean corpus
files from `$S/sample50.txt` (all 50 returned `ok`), so the grammar agrees with the real
parser on both sides.

## Baseline (src/parser/treeSitter/grammars/tree-sitter-axon.wasm before this work)

| part | files | clean | with ERROR | with MISSING |
|---|---|---|---|---|
| axon | 3506 | 3467 (98.9%) | 38 | 3 |
| trio-src | 1146 | 1143 (99.7%) | 2 | 2 |

Of the 42 non-clean files, 18 fail the Axon parser; 24 parse with Haxall and were grammar
bugs.

## After (2026-11-12)

| part | files | clean | with ERROR | with MISSING |
|---|---|---|---|---|
| axon | 3492 | 3475 (99.5%) | 14 | 3 |
| trio-src | 1146 | 1143 (99.7%) | 1 | 3 |

Every one of the 20 non-clean files is rejected by the Axon parser (table below), so the
gate is met: 100% of valid Axon in both parts is clean. `tree-sitter test --wasm`:
87 / 87.

Baseline failures that parse with Haxall, grouped by cause, all fixed:

| cause | files | fix |
|---|---|---|
| nested `/* /* */ */` block comments (Tokenizer.fan `skipCommentML` counts depth) | 6 | `block_comment` moved to `src/scanner.c` |
| non-ASCII unit chars `1€`, `1₤` (Tokenizer.fan `num`: any char > 128) | 5 | unit regex accepts `\u0080-￿` |
| U+00A0 no-break space used as whitespace | 3 | added to `extras` |
| `if (c) do ... else ...` / `try do ... catch ...` nested inside a lambda, paren or list (Parser.fan `doBlock` breaks on `else`/`catch` without consuming `end`) | 10 | `do_block` ends with `end` or the scanner's zero-width `_implicit_end`; `if_expr` / `try_catch_expr` lost their special `do` forms |

The last fix also changes the tree for `if (c) do x else y` and `try do x catch y`: the
body before `else` / `catch` is now a `do_block` (field `then` / `body`), the same node as
every other do block. `src/axon/axonTreeSitter.ts` only reads `do_block` children, so it
needs no change. `do_block` now requires at least one expression, as Parser.fan does
(`exprs := [expr]`); an empty `do end` is a parse error in Haxall too.

Node names relied on by `src/axon/axonTreeSitter.ts` and `languageRegistry.ts`
`axonMappings` are unchanged. New externals: `block_comment` (same node name as before),
`_implicit_end` (hidden), and the keywords `else` / `catch` listed so the scanner can read
`valid_symbols` (a dangling `else` still binds to the nearest `if`).

## Excluded files

Each file below is rejected by `axon::Parser` (SkySpark 3.1.12, same Parser.fan as
Haxall 4.0.4) and again by the live SkySpark 3.1.6 `parseAst` oracle described above.
`line` is the local parser's error line, `tree-sitter` the first bad node.

| path | line | Axon parser message | tree-sitter |
|---|---|---|---|
| SRC/79fa9aa19d53-boo.axon | 2 | `Unexpected token end` (empty `do end`) | 2:4 MISSING end |
| SRC/b61ef6a92aab-foo.axon | 2 | `Unexpected token end` (empty `do end`) | 2:4 MISSING end |
| SRC/be84fd0127b4-kpi_runtime_exFan.axon | 16 | `Expecting colon and value after "if" dict literal` (`{` used as a block) | 15:25 ERROR |
| ~/Code/2020/axon/siemens/ahu_testing/ahuSensorRatMatRecircErr.axon | 33 | `Unexpected token end` (empty `do end`) | 33:4 MISSING end |
| ~/Code/2020/bassgaxonlibrary/pbpAxonFunctions/functionStuckJob.axon | 1 | `Expecting '(...) =>' top-level function` | 10:17 ERROR `=> do` |
| ~/Code/2026/poppy/proj/Ecosmart/ecosmart/func/makeHourOffsets.axon | 13 | `Expecting 'end', not end of file` (`do ... while`) | 13:4 MISSING end |
| ~/Code/2026/poppy/proj/localhost8080/mobilytik/func/taskToCheckSparksV2.axon | 17 | `Expecting 'end', not end of file` | 1:3 ERROR |
| ~/Code/2026/poppy/proj/localhost8080/solrenview/.backups/solrenviewCreateSiteEquipPoints/backup-2026-03-26T23-47-41-070Z.axon | 82 | `Expecting newline or semicolon, not =>` | 82:34 ERROR |
| ~/Code/2026/poppy/proj/localhost8080/solrenview/.backups/solrenviewImportPoints/backup-2026-03-26T23-32-29-864Z.axon | 2 | `Unexpected token =` (`:=`) | 2:7 ERROR |
| ~/Code/2026/poppy/proj/localhost8080/solrenview/.backups/solrenviewImportPoints/backup-2026-03-26T23-34-16-659Z.axon | 13 | `Expecting newline or semicolon, not =>` | 13:21 ERROR |
| ~/Code/2026/poppy/proj/localhost8080/solrenview/.backups/solrenviewSyncAll/backup-2026-03-26T23-34-29-642Z.axon | 14 | `Expecting newline or semicolon, not =>` | 14:21 ERROR |
| ~/Code/2026/poppy/proj/localhost8080/solrenview/.backups/solrenviewSyncAll/backup-2026-03-27T02-37-21-983Z.axon | 48 | `Unexpected token if` | 48:98 ERROR |
| ~/Code/2026/poppy/proj/skyone/granlund/func/coolingView.axon | 2 | `Expected dict tag name, not {` (`{{span}}` template) | 2:48 ERROR |
| ~/Code/2026/poppy/proj/skyone/granlund/func/zoneTempGuardian.axon | 24 | `return must be followed by expr on same line` | 61:22 ERROR (`?.`, `?:`) |
| ~/Code/axon-mcp-server/proj/Sensor Read Production/sensorRead/.backups/poppyDemo_buildPage/backup-2026-06-04T17-48-00-825Z.axon | 7 | `Expecting newline or semicolon, not :` | 7:4 ERROR |
| ~/Code/axon-mcp-server/proj/Sensor Read Production/sensorRead/.backups/poppyDemo_buildPage/backup-2026-06-04T17-49-11-938Z.axon | 7 | `Expecting newline or semicolon, not :` | 7:4 ERROR |
| ~/Code/axon-mcp-server/proj/Sensor Read Production/sensorRead/.backups/poppyDemo_buildPage/backup-2026-06-04T18-17-57-628Z.axon | 6 | `Expecting newline or semicolon, not :` | 6:4 ERROR |
| ~/Code/axon-mcp-server/proj/Sensor Read Production/sensorRead/.backups/poppyDemo_buildPage/backup-2026-06-04T18-19-35-008Z.axon | 5 | `Expecting newline or semicolon, not :` | 5:4 ERROR |
| ~/Code/axon-mcp-server/proj/michealsEnergy/walmartcostarica/.backups/spk_compLowPowerOutsideShed/backup-2026-10-14T11-00-34-945Z.axon | 77 | `Expected ,, not ?` (`?:`) | 77:56 ERROR |
| ~/Code/axon_library_2025/axon-library/bassg/Stan/cur_FahrenheitToCelsius.axon | 39 | `Expected end, not eof` | 38:4 MISSING end |

`SRC/` is `$S/axon-src-blocks/`. The three `empty do end` files were clean at baseline
only because the old grammar accepted an empty block, which Parser.fan does not.
