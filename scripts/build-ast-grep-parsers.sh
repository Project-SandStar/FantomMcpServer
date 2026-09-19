#!/usr/bin/env bash
# Build the in-repo tree-sitter grammars (Fantom, Axon, Xeto, Trio) as ast-grep
# dynamic libraries into .ast-grep/parsers/, where sgconfig.yml expects them.
# Re-run after any grammar change (tree-sitter generate first).
set -euo pipefail
cd "$(dirname "$0")/.."
out=.ast-grep/parsers
mkdir -p "$out"
case "$(uname -s)" in
  Darwin) ext=dylib ;;
  *)      ext=so ;;
esac
for lang in fantom axon xeto trio; do
  g="tree-sitter-$lang"
  [[ -f "$g/src/parser.c" ]] || { echo "skip $lang: $g/src/parser.c missing (run tree-sitter generate)"; continue; }
  srcs=("$g/src/parser.c")
  [[ -f "$g/src/scanner.c" ]] && srcs+=("$g/src/scanner.c")
  cc -shared -fPIC -O2 -I "$g/src" "${srcs[@]}" -o "$out/$lang.$ext"
  echo "built $out/$lang.$ext"
done
