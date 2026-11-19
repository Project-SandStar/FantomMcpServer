# tree-sitter-fantom corpus status

Goal: parse every real, compiled `.fan` file with zero `ERROR` and zero `MISSING` nodes.
Gate for the `.fan` route switch: 100% clean files on Tier 1, Tier 2 and the build.fan bucket.

## Measure

```bash
cd tree-sitter-fantom && tree-sitter generate && tree-sitter test --wasm \
  && tree-sitter build --wasm -o tree-sitter-fantom.wasm
S=/private/tmp/claude-501/-Users-alper-Code-mcpfantom/49d9dc3d-e274-4367-87b1-2843bd9057a3/scratchpad
node scripts/fantom-grammar-corpus.mjs --top 30 \
  fantom=$S/corpus-tier1-fantom.txt haxall=$S/corpus-tier1-haxall.txt build=$S/corpus-build.txt
node scripts/fantom-grammar-corpus.mjs --top 30 tier2=$S/corpus-tier2.txt
```

Corpus lists (one path per line, built with `find`, Tier 2 deduped by content hash):

| list | files | source |
|---|---|---|
| corpus-tier1-fantom.txt | 822 | ~/Downloads/fantom-1.0.84/src (no build.fan) |
| corpus-tier1-haxall.txt | 1680 | ~/haxall/haxall-4.0.4/home/src (no build.fan) |
| corpus-build.txt | 163 | every build.fan under both Tier 1 roots |
| corpus-tier2.txt | 4485 | ~/fantom + ~/Code, deduped, minus node_modules/.git/build/out/tree-sitter-*/test (4471 source + 14 build.fan; see pruning note below) |

## Baseline (before this work)

| tier | files | clean | with ERROR | with MISSING |
|---|---|---|---|---|
| fantom | 822 | 415 | 406 | 56 |
| haxall | 1680 | 780 | 897 | 110 |
| build.fan | 163 | 0 | 163 | 3 |

Corpus tests at baseline: 22, 16 pass.

## After (2026-11-11)

| tier | files | clean | with ERROR | with MISSING |
|---|---|---|---|---|
| fantom | 822 | 822 | 0 | 0 |
| haxall | 1680 | 1680 | 0 | 0 |
| build.fan | 163 | 163 | 0 | 0 |
| tier2 | 4471 | 4468 | 3 | 0 |
| tier2/build.fan | 14 | 14 | 0 | 0 |

Corpus tests: 50, 50 pass. The 3 non-clean Tier 2 files are not valid Fantom (see Excluded files).
Tier 2 list changes: 11 paths under a deleted git worktree
(`~/Code/2026/visualytik/visualytik2026/.worktrees/dc-fix/`) no longer exist on disk and were dropped;
every `.fan` under the live `~/Code/2026/visualytik` checkout was then parsed (86 files, all clean) and the
36 whose content hash was not already in the list were added (4460 -> 4485).

External scanner: `src/scanner.c`. Wired in `binding.gyp` and `bindings/rust/build.rs`; the Makefile
already compiles every `src/*.c` via a wildcard, as in tree-sitter-axon.
Tokens: `comment` (nested `/* /* */ */`; the scanner shares the `comment` node name with the `//` rule in
grammar.js, so the node type did not change), `_lbracket_same_line` (`[` with no newline before it and
not `[]`), `_same_line` (identifier on the same line, for `Type#slot` vs `Int[]#` + newline),
`_closure_ahead` (`|...|` followed by `{`, so a func-type field on the next line is not a trailing closure).

Frozen node names all kept (`method_def`, `ctor_def`, `class_definition`, `mixin_definition`, `field_def`,
`using_statement`, `postfix_expr`, `call_args`, `param_list`, `block`, `comment`, `doc_comment`,
`identifier`, `type_ref`, `simple_type`, `qualified_type_name`, `class_body`, and the fields `name`, `body`,
`return_type`, `type`). Renamed/removed non-frozen rules: `_ctor_chain` -> `ctor_chain`, `type_args` and
`type_params` removed (Fantom has no generics syntax outside sys).
New nodes: `ffi`, `shebang`, `static_type_expr`, `storage_expr`, `throw_expr`, `field_accessor`.

## Fix log

Each step: generate exit 0, `test --wasm` green, Tier 1 clean count did not drop, committed.

| step | commit | fix | Tier 1 clean (fantom / haxall / build) |
|---|---|---|---|
| 0 | b692587 | corpus tests expect `local_def` for `x := ...` | 415 / 780 / 0 |
| 1 | c419e69 | type rules rewritten as a postfix loop (`?`, `[]`, `:V`), func type `\|A,B->R\|`, closure body is always a block | 592 / 1276 / 157 |
| 2 | a95180c | number suffixes `f d e _`, `\u{...}` escape, try body `;` | 642 / 1357 / 157 |
| 3 | c77c894 | strings as single tokens, ctor chain `super.name()`, accessor modifiers, it-block commas, DSL content | 745 / 1554 / 163 |
| 4 | af5427a | scanner: nested block comments; `&field`, `using [java]`, uri escapes | 776 / 1605 / 163 |
| 5 | c538f44 | scanner: same-line `[` and `#slot`; facets over newlines, class `;`, `pod::Type` expr, `$` in FFI names | 807 / 1650 / 163 |
| 6 | 761794b | scanner: closure-ahead; it-add commas in any `expr_stmt`, enum value facets, accessor `;`, `***` doc, `x? a : b` | 808 / 1655 / 163 |
| 7 | 2a9a55e | `Obj?[]` in `as`/`is`, enum body `;`, `throw` in ternary/elvis, `new static`, `{ private }` accessor | 821 / 1679 / 163 |
| 8 | 55d36eb | leading-dot decimal `.2D` | 822 / 1680 / 163 |
| 9 | 292a6ce | `using ...;`, case blocks after `default:` | 822 / 1680 / 163 |
| 10 | (this commit) | scanner block comments emitted as `comment`; batch of corpus tests for earlier fixes | 822 / 1680 / 163 |

## Excluded files

Each file was compiled with `~/Downloads/fantom-1.0.84/bin/fan` on a 3-line snippet of the
offending construct; the compiler rejects all three. A copy of each file with only that construct
neutralised (`extension ` removed, `=>` -> `:`, `...` -> `..<`, two places in updateheader.fan) parses with
zero ERROR and zero MISSING, so the rest of each file is accepted by the grammar.

| path | line | reason | compiler message |
|---|---|---|---|
| ~/Code/2026/cmmsPlugins/siSeven/bassgsiseven/fan/Index.fan | 556 | `static extension Str mult(...)`: `extension` is not a Fantom keyword | Unknown type 'extension' |
| ~/Code/2020/eac-tools/OemMain.fan | 12 | map literal with `"Debian" => "DEB"`: `=>` is not a Fantom token | Expected expression, not '>' |
| ~/fantom/fantom-1.0.78/adm/updateheader.fan | 68 | `creation[0...creation.index(...)]`: `...` is not a range operator (`..` / `..<` only) | Expected expression, not '.' |

## Remaining failures by cause

None on Tier 1 or build.fan. Tier 2: only the three excluded files above.
