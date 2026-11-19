# tree-sitter-trio corpus status

Goal: parse every real `.trio` file with zero `ERROR` and zero `MISSING` nodes, the same gate
`tree-sitter-fantom/CORPUS.md` met for `.fan` files. Exclude a file only if it is not valid Trio,
and prove it with `haystack::TrioReader`, the reference reader.

## Measure

```bash
cd tree-sitter-trio && tree-sitter generate && tree-sitter test --wasm \
  && tree-sitter build --wasm -o tree-sitter-trio.wasm && cd ..
S=/private/tmp/claude-501/-Users-alper-Code-mcpfantom/49d9dc3d-e274-4367-87b1-2843bd9057a3/scratchpad
node tree-sitter-trio/scripts/corpus.mjs tree-sitter-trio/tree-sitter-trio.wasm $S/corpus-trio.txt --top 30
```

Corpus list (one path per line, `node tree-sitter-trio/scripts/build-corpus.mjs $S/corpus-trio.txt`): every `*.trio` under `~/haxall/haxall-4.0.4`,
`~/Downloads/fantom-1.0.84` and `~/Code`, skipping `node_modules`, `.git`,
`build`, `out` and `tree-sitter-*/test`; 12924 files found, deduped by content hash to 3539.

| tier | files | source |
|---|---|---|
| haxall | 82 | ~/haxall/haxall-4.0.4 (home/src/**/lib/*.trio) |
| fantom | 0 | ~/Downloads/fantom-1.0.84 has no .trio files |
| code | 3457 | ~/Code (SkySpark project exports, rule libraries, templates) |

Reference check with the real reader (SkySpark 3.1.12 ships the `haystack` pod; Haxall 4.0.4 has no
`bin/fan`, so the SkySpark launcher was used):

```bash
# every file through TrioReader.readAllDicts; prints "ok=N bad=N" and one "ERR <path>: <msg> CAUSE=<cause>" line per rejected file
~/skyspark/skyspark-3.1.12/bin/fan tree-sitter-trio/scripts/TrioCheck.fan $S/corpus-trio.txt
# same, but prints "<path>\t<records>\t<tags>\t<crc>" or "<path>\tERR"
~/skyspark/skyspark-3.1.12/bin/fan tree-sitter-trio/scripts/TrioCount.fan $S/corpus-trio.txt > $S/reader-counts.tsv
# per file: record and tag counts from the wasm parse must equal the reader's
node tree-sitter-trio/scripts/compare-reader.mjs tree-sitter-trio/tree-sitter-trio.wasm $S/reader-counts.tsv
```

## Baseline (2026-11-11, wasm from commit e43c6fd, unchanged)

| tier | files | clean | with ERROR | with MISSING |
|---|---|---|---|---|
| haxall | 82 | 82 | 0 | 0 |
| code | 3457 | 3454 | 3 | 1 |
| all | 3539 | 3536 | 3 | 1 |

Corpus tests: 7, 7 pass. `tree-sitter generate` with CLI 0.26.5 leaves `src/grammar.json` unchanged
and a rebuilt wasm gives the same counts, so the shipped wasm matches `grammar.js`.

## After (2026-11-11)

| tier | files | clean | with ERROR | with MISSING |
|---|---|---|---|---|
| haxall | 82 | 82 | 0 | 0 |
| code | 3457 | 3454 | 3 | 1 |
| all | 3539 | 3536 | 3 | 1 |

No grammar change was needed. The 3 non-clean files are the 3 files `TrioReader` rejects with
`Invalid name` (see Excluded files). Reader agreement: `TrioReader` accepts 3118 of 3539 files; on every one of them the grammar yields
the same number of `record` nodes and the same number of `tag` + `block_tag` nodes as the reader
returns dicts and tags (3118 same, 0 different).

CRLF: 27 corpus files contain `\r`. `parseTrio` (`src/parser/treeSitter/trioGrammar.ts`) returns
200 string values from them and none contains `\r`; no tag name contains `\r` (commit e43c6fd).

Node names: unchanged. `source_file`, `record`, `tag`, `block_tag`, `name`, `indented_text`,
`zinc_block`, `trio_block`, `list_block`, `dict_block`, `separator`, `comment`, the scalar nodes
(`ref`, `symbol`, `str`, `uri`, `date_time`, `date`, `time`, `number`, `bool`, `na`, `remove`,
`list`, `dict`, `xstr`, `raw`) and the fields `name`, `value`, `kind` are what
`src/parser/treeSitter/trioGrammar.ts` reads.

## Fix log

| step | commit | fix | clean (haxall / code) |
|---|---|---|---|
| 0 | e43c6fd | baseline: CRLF values keep no `\r` | 82 / 3454 |
| 1 | 84555eb | corpus scripts + this file; no grammar change | 82 / 3454 |
| 2 | (this commit) | list builder, TrioCheck, After table, verified leniency causes | 82 / 3454 |

## Excluded files

Each file was read with `haystack::TrioReader` (SkySpark 3.1.12); the reader rejects all three.
A copy of `mGetSparks_spark.trio` with lines 13-14 indented by two spaces parses with zero ERROR and
zero MISSING and the reader accepts it, so the rest of the file is valid Trio. The two `config.trio`
files are Java properties files (8 and 6 lines, every line matches `^[A-Za-z_.]+=`, different values);
a 2-line `port=9099` sample fails the same way.

| path | line | reason | TrioReader message |
|---|---|---|---|
| ~/Code/2020/GitConverted/mobilytikgit/tool/bassgMobilytikExt/lib/mGetSparks_spark.trio | 13 | `doc:` block text is not indented, so the next line is read as a tag name with spaces | Invalid name: Returns sparks under record with [recId] including nested records. [Line 13] |
| ~/Code/2026/coned-green-button-data/server/proxy_config.trio | 1 | Java properties file, not Trio | Invalid name: port=9099 [Line 1] |
| ~/Code/MileSight/bassgmilesight/proxyServer/config.trio | 1 | Java properties file, not Trio (CRLF) | Invalid name: port=9099 [Line 1] |

## Grammar leniency

The grammar parses 418 further files clean that `TrioReader` rejects. They are SkySpark project
exports and rule libraries that the indexer must still read, so the grammar accepts them on purpose.

| count | TrioReader message | what the grammar does |
|---|---|---|
| 402 | Invalid tag value for "help": "... | quoted string spanning lines: `str` allows a newline inside quotes |
| 7 | Invalid tag value for "doc": "... | same |
| 4 | Invalid tag value for "parameters": [ | `[` alone on the line with an indented body is a `list_block`; the body is one `indented_text` token and is not parsed. The reader accepts a plain or `//`-commented indented list, but these files hold JSON-style dicts (`required:true`, `name:"x"`), cause `Unexpected identifier "true"` |
| 1 | Invalid tag value for "parameters": { | `{` alone on the line with an indented body is a `dict_block`, same unparsed body; the reader parses only `{` as Zinc, cause `Expected } not eof` |
| 4 | Duplicate tag: id | two `id` tags in one record; the grammar does not check tag uniqueness |

## Remaining failures by cause

None. Only the three excluded files above.
