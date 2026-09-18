# Axon Grammar — Failing Scripts

Tracked failures from `tree-sitter-axon` grammar testing against the Axon library.

**Test date:** 2026-02-14
**Test command:** `./scripts/check-axon-grammar.sh`
**Results:** 1356/1359 passed (99.8%), 3 failed

## Current Failing Files (3)

### Category 1: Invalid Axon — SkySpark Also Rejects (2 files)

| File | SkySpark Error | tree-sitter Error |
|------|----------------|-------------------|
| `bassg/Stan/cur_FahrenheitToCelsius.axon` | `SyntaxErr: Expected end, not eof` | MISSING "end" [37,3] |
| `pbpAxonFunctions/functionStuckJob.axon` | `SyntaxErr: Expecting end of file, not (` | ERROR [9,16] |

- `cur_FahrenheitToCelsius.axon`: defcomp missing final `end` keyword
- `functionStuckJob.axon`: Two top-level expressions (function call + lambda definition)

**No grammar fix needed** — these are genuinely broken files.

### Category 2: File Encoding Issue (1 file)

| File | Issue | tree-sitter Error |
|------|-------|-------------------|
| `lmdfuncs/importDataFromEsd.axon` | Latin-1 byte `0xB2` instead of UTF-8 `0xC2 0xB2` | ERROR [83,39]-[83,40] |

- The `²` character in `1ft²` is encoded as Latin-1 (single byte `0xB2`), not UTF-8 (`0xC2 0xB2`)
- When converted to UTF-8 with `iconv -f ISO-8859-1 -t UTF-8`, the file parses perfectly
- **No grammar fix needed** — this is a file encoding issue, not a grammar issue

## TODO

- [x] Verify lambda default params parse correctly in SkySpark's native Axon parser
- [x] Fix tree-sitter-axon grammar to handle `param` with default values
- [x] Rebuild WASM after grammar fix
- [x] Re-test after grammar changes with `./scripts/check-axon-grammar.sh`
- [x] Verify 13 remaining failures against SkySpark's native parser
- [x] Fix unclosed block comment handling (6 files)
- [x] Fix trailing lambda with if-return pattern (edit_hisRewriteNull)
- [x] Fix nested trailing lambda parsing (convertFahrenheitToCelsius)
- [x] Investigate spk_hpONUnoccTempInSP and vavDamperPositionNotMeetingSetpoint
- [x] Fix corrupted Unicode unit parsing (importDataFromEsd) — file encoding issue, not grammar

## Fixed Issues

- **Lambda parameter defaults** — Split `param` rule with `prec(15)` on the default variant to match `define_var` precedence, enabling GLR disambiguation. Fixed: `Dubai/findDuplicatePointsViaJob.axon`, `Dubai/findDuplicatesInEquipVariable.axon`, `abc/library/admin_runSnapshotCycle.axon`
- **Unicode subscript units** — Added `\u2080-\u2089` to number unit character class for units like `inH₂O`. Fixed: `abc/library/spk_ahuFanFailure.axon`
- **Unclosed block comments** — Modified `block_comment` regex to make closing `*/` optional, matching SkySpark's tolerance for unterminated comments at EOF. Fixed 6 files: `spk_equipReturnTempHigh`, `hisExport_ElecMeters`, `hisRemove_Questionmarks`, `integrate_trap`, `bacnetOverwrite_TempActiveSP`, `hisOnWrite_OccToBool`
- **Newline-as-statement-boundary (INDEX_AHEAD)** — Added `_index_ahead` external scanner token that only emits when `[` appears on the same line as the preceding expression. Prevents newline-separated `[list]` from being misinterpreted as index access on the preceding expression, matching Haxall's `isEos` behavior. Fixed: `edit_hisRewriteNull.axon`, `convertFahrenheitToCelsius.axon`, `spk_hpONUnoccTempInSP.axon`
- **Bare return support** — Made `return_expr` take optional expression (`return` without value returns null). Previously `return` consumed the following `end` keyword as its expression, stealing it from the enclosing `do_block`. Fixed: `vavDamperPositionNotMeetingSetpoint.axon`

## Grammar Fixes Summary

### Fix 1: Lambda Parameter Defaults
Split `param` into two alternatives with targeted precedence:
- `param` with default: `prec(15, seq(identifier, ":", _expr))` — matches `define_var` precedence, forces GLR fork
- `param` without default: `field("name", identifier)` — keeps default prec(0), preserves existing behavior
- Added conflict `[$.param, $.define_var]` for GLR disambiguation

### Fix 2: Unclosed Block Comments
Modified `block_comment` regex to make closing `*/` optional:
```js
token(seq("/*", /[^*]*(\*+([^/*][^*]*\*+)*\/|\*+)?/))
```

### Fix 3: Newline-Separated Index Prevention (INDEX_AHEAD)
Added external scanner token `_index_ahead` (zero-width) that checks for `[` on the same line. Modified `index_expr` to require this token before `[`. Scanner logic:
- Skip spaces/tabs (not newlines)
- If newline encountered before `[`, return false (no index access)
- If `[` on same line, emit `INDEX_AHEAD`

### Fix 4: Bare Return
Changed `return_expr` from required to optional expression:
```js
return_expr: ($) => prec.right(1, seq("return", optional($._expr)))
```
