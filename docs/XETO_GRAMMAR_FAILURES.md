# Xeto Grammar — Failing Files

Tracked failures from `tree-sitter-xeto` grammar testing against the Haxall xeto library.

**Test date:** 2026-02-14
**Test command:** `./scripts/test-xeto-grammar.sh`
**Results:** 79/85 passed (92.9%), 6 failed

All 6 failures are in the `hx.test.xeto` test library. All production xeto files parse cleanly.

## Root Causes

Three distinct grammar gaps cause all 6 failures:

### 1. No-space colon in slot names (`metaNum:"987"`)
The grammar treats newlines as significant and relies on whitespace patterns. When a slot
definition omits the space before the colon (`metaNum:"987"` vs `metaNum: "987"`), the lexer
cannot distinguish the slot name from the colon token.

### 2. Nested angle brackets in meta (`List <of:Ref<of:A>>`)
The `<` and `>` tokens used for meta blocks conflict with nested generic-style type parameters.
`Ref<of:A>` inside an outer `<...>` causes the parser to close the outer meta block prematurely
at the first `>`.

### 3. List literals with scalars (`{"2024-11-26", "2024-11-27"}`)
Bodies containing only comma-separated scalar values are used as list literals. While bare
scalars in bodies are supported, the comma-separated pattern inside a body used as a slot
value (after `:`) triggers ambiguity between `body` and `dict_literal`.

## Failing Files

### 1. `hx.test.xeto.deep/test.xeto`
- **Error:** `(ERROR [13, 16] - [13, 20])`
- **Pattern:** `metaNum:"987"` (no space before colon)
- **Root cause:** #1

### 2. `hx.test.xeto/fidelity.xeto`
- **Error:** `(ERROR [30, 21] - [30, 25])`, `(ERROR [34, 12] - [34, 20])`
- **Pattern:** `numbers: List <val:List { Int 2, Float 3, Number 4 }>`
- **Root cause:** Nested `List` type with inline instances inside meta value

### 3. `hx.test.xeto/instances.xeto`
- **Error:** `(ERROR [37, 8] - [37, 18])`
- **Pattern:** `a: {"2024-11-26", "2024-11-27"}`
- **Root cause:** #3

### 4. `hx.test.xeto/instantiate.xeto`
- **Error:** `(ERROR [22, 8] - [22, 15])`, `(ERROR [34, 9] - [34, 13])`
- **Pattern:** `icon: @icon-b` — ref literal used as slot value
- **Root cause:** `ref_literal` not included in slot value alternatives (only in `_meta_val` / `_dict_val`)

### 5. `hx.test.xeto/scalars.xeto`
- **Error:** `(ERROR [12, 10] - [12, 14])`
- **Pattern:** `@scalars: Dict {` — instance with explicit type after `@ref:`
- **Root cause:** Instance ref followed by type then body; the `Dict` type parses but `{` triggers ambiguity

### 6. `hx.test.xeto/test.xeto`
- **Error:** `(ERROR [82, 17] - [82, 18])`, `(ERROR [82, 23] - [82, 24])`
- **Pattern:** `h: List <of:Ref<of:A>>`
- **Root cause:** #2

## TODO

- [ ] Fix #4 (ref_literal as slot value) — add `$.ref_literal` to slot_def value choices
- [ ] Fix #1 (no-space colon) — investigate lexer-level fix for `name:value` without space
- [ ] Fix #2 (nested angle brackets) — may require external scanner for `<>` balancing
- [ ] Fix #3 (list literal body) — comma-separated scalars inside body-as-value
- [ ] Re-test after any grammar changes with `./scripts/test-xeto-grammar.sh`

## Fixed Issues (previously failing)

- All 35 `lib.xeto` files — Fixed by adding `$._scalar_val` to body choices (bare strings like `{"haxall"}`)
- `categories: {"haxall"}` pattern — Same fix (scalar values inside body)
- Qualified type refs like `ph::Site` — Fixed by accepting simple lib name in `qualified_name`
- Spec definitions without type (`Name: { body }`) — Fixed by making type optional after `:`
