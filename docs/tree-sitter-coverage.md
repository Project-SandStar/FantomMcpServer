# tree-sitter-fantom coverage matrix

Generated: 2026-05-08T08:49:52.310Z

Per-file tree-sitter vs regex parser, with authoritative pod-level totals where the pod is compiled and discoverable. Authoritative counts are POD-level (sum of all .fan files in that pod's source dir), so they can't be compared 1:1 to a single file — but they bound what tree-sitter could find by parsing every file in that pod.

| File | Pod | TS fns | TS types | Regex fns | Regex types | Pod-level auth fns | Pod-level auth types | Notes |
|---|---|---|---|---|---|---|---|---|
| `xml/fan/XParser.fan` | xml | 64 | 2 | 109 | 2 | 116 | 13 | classes with @Js facets |
| `xml/fan/XElem.fan` | xml | 33 | 1 | 42 | 1 | 116 | 13 | @Js mixin-style class |
| `xml/test/DomTest.fan` | — | 6 | 1 | 6 | 1 | — | — | call+it-block, typed empty list |
| `xml/test/ParserTest.fan` | — | 11 | 1 | 12 | 1 | — | — | verifyEq + verifyErr |
| `dom/fan/Win.fan` | dom | 48 | 1 | 38 | 1 | 310 | 28 | closures |
| `concurrent/fan/Future.fan` | concurrent | 23 | 2 | 5 | 1 | 108 | 14 | closures + statics |
| `sys/fan/Duration.fan` | — | 36 | 1 | 36 | 1 | — | — | operator methods |
| `compiler/fan/parser/Parser.fan` | — | 95 | 1 | 215 | 1 | — | — | recursive descent (~1500 lines) |
| `compiler/fan/parser/Tokenizer.fan` | — | 41 | 1 | 121 | 2 | — | — | char literals + escapes |
| `fandoc/fan/FandocParser.fan` | — | 40 | 1 | 62 | 2 | — | — | block comments |
| `fwt/fan/Widget.fan` | — | 44 | 1 | 49 | 1 | — | — | event closures |
| `sys/fan/List.fan` | — | 80 | 1 | 75 | 1 | — | — | mixin-heavy |
| `sys/fan/Map.fan` | — | 44 | 1 | 42 | 1 | — | — | generic types |
| `sys/fan/Str.fan` | — | 73 | 1 | 73 | 1 | — | — | methods with operators |
| `sys/fan/Type.fan` | — | 43 | 1 | 42 | 1 | — | — | reflection-heavy |
| `dom/fan/Elem.fan` | dom | 66 | 1 | 20 | 1 | 310 | 28 | large class |
| `flux/fan/Frame.fan` | flux | -1 | -1 | -1 | -1 | — | — | MISSING: using ffi (java imports) |
| `concurrent/fan/Actor.fan` | concurrent | 15 | 1 | 0 | 0 | 108 | 14 | closures + sends |
| `util/fan/Crypto.fan` | util | -1 | -1 | -1 | -1 | — | — | MISSING: utility class |
| `sys/fan/Endian.fan` | sys | 0 | 0 | 0 | 1 | 1358 | 103 | enum class |
