#!/usr/bin/env bash
#
# test-xeto-grammar.sh — Validate the tree-sitter-xeto grammar
#
# Usage:
#   ./scripts/test-xeto-grammar.sh                    # Run all tests
#   ./scripts/test-xeto-grammar.sh --corpus-only       # Run tree-sitter corpus tests only
#   ./scripts/test-xeto-grammar.sh --parse-only        # Parse real xeto files only
#   ./scripts/test-xeto-grammar.sh --file <path>       # Parse a single file
#
# Requires: tree-sitter CLI (brew install tree-sitter)
#

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GRAMMAR_DIR="$PROJECT_DIR/tree-sitter-xeto"
XETO_SOURCE="${XETO_SOURCE:-~/haxall/haxall-4.0.4/src/xeto}"

# Counters
PASS=0
FAIL=0
TOTAL=0
ERRORS_LIST=""

# ============================================================================
# Helpers
# ============================================================================

print_header() {
  echo ""
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}${CYAN}  $1${NC}"
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

check_prereqs() {
  if ! command -v tree-sitter &>/dev/null; then
    echo -e "${RED}Error: tree-sitter CLI not found. Install with: brew install tree-sitter${NC}"
    exit 1
  fi

  if [ ! -f "$GRAMMAR_DIR/grammar.js" ]; then
    echo -e "${RED}Error: grammar.js not found at $GRAMMAR_DIR${NC}"
    exit 1
  fi
}

# ============================================================================
# Phase 1: Tree-sitter corpus tests
# ============================================================================

run_corpus_tests() {
  print_header "Phase 1: Tree-sitter Corpus Tests"

  cd "$GRAMMAR_DIR"

  # Regenerate parser
  echo -e "${CYAN}Generating parser...${NC}"
  if ! tree-sitter generate 2>&1 | grep -v "^Warning:"; then
    echo -e "${RED}Parser generation failed!${NC}"
    return 1
  fi

  echo -e "${CYAN}Running test corpus...${NC}"
  echo ""

  if tree-sitter test 2>&1; then
    echo ""
    echo -e "${GREEN}All corpus tests passed.${NC}"
    return 0
  else
    echo ""
    echo -e "${RED}Some corpus tests failed.${NC}"
    return 1
  fi
}

# ============================================================================
# Phase 2: Parse real xeto files
# ============================================================================

parse_single_file() {
  local filepath="$1"
  local filename
  filename="$(basename "$filepath")"
  local dirname
  dirname="$(basename "$(dirname "$filepath")")"
  local label="$dirname/$filename"

  TOTAL=$((TOTAL + 1))

  local output
  output=$(tree-sitter parse "$filepath" 2>/dev/null)
  local exit_code=$?

  if [ $exit_code -ne 0 ]; then
    FAIL=$((FAIL + 1))
    echo -e "  ${RED}FAIL${NC}  $label (parse error)"
    ERRORS_LIST="$ERRORS_LIST\n  - $label (parse error)"
    return
  fi

  if echo "$output" | grep -q "ERROR\|MISSING"; then
    FAIL=$((FAIL + 1))
    local error_count
    error_count=$(echo "$output" | grep -c "ERROR\|MISSING" || true)
    echo -e "  ${RED}FAIL${NC}  $label ($error_count error nodes)"
    ERRORS_LIST="$ERRORS_LIST\n  - $label ($error_count errors)"
  else
    PASS=$((PASS + 1))
    echo -e "  ${GREEN}OK${NC}    $label"
  fi
}

run_parse_validation() {
  print_header "Phase 2: Validate Against Real Xeto Files"

  if [ ! -d "$XETO_SOURCE" ]; then
    echo -e "${YELLOW}Xeto source directory not found: $XETO_SOURCE${NC}"
    echo -e "${YELLOW}Set XETO_SOURCE env var to point to your xeto files.${NC}"
    echo -e "${YELLOW}Skipping real file validation.${NC}"
    return 0
  fi

  cd "$GRAMMAR_DIR"

  # Ensure parser is generated
  tree-sitter generate 2>/dev/null

  echo -e "${CYAN}Parsing .xeto files from: $XETO_SOURCE${NC}"
  echo ""

  PASS=0
  FAIL=0
  TOTAL=0
  ERRORS_LIST=""

  # Find and parse all .xeto files
  while IFS= read -r -d '' file; do
    parse_single_file "$file"
  done < <(find "$XETO_SOURCE" -name "*.xeto" -print0 | sort -z)

  echo ""
  echo -e "${BOLD}Results:${NC}"
  echo -e "  Total:  $TOTAL"
  echo -e "  ${GREEN}Pass:   $PASS${NC}"
  echo -e "  ${RED}Fail:   $FAIL${NC}"

  if [ $TOTAL -gt 0 ]; then
    local pct=$((PASS * 100 / TOTAL))
    echo -e "  Rate:   ${pct}%"
  fi

  if [ -n "$ERRORS_LIST" ]; then
    echo ""
    echo -e "${YELLOW}Failed files:${NC}"
    echo -e "$ERRORS_LIST"
  fi

  echo ""
  if [ $FAIL -eq 0 ]; then
    echo -e "${GREEN}All files parsed successfully!${NC}"
  elif [ $PASS -gt $((TOTAL / 2)) ]; then
    echo -e "${YELLOW}Most files pass. Remaining failures are likely edge cases.${NC}"
  else
    echo -e "${RED}Many files failing — grammar needs work.${NC}"
  fi
}

# ============================================================================
# Phase 3: WASM build check
# ============================================================================

check_wasm() {
  print_header "Phase 3: WASM Build Status"

  local wasm_grammar="$GRAMMAR_DIR/tree-sitter-xeto.wasm"
  local wasm_installed="$PROJECT_DIR/src/parser/treeSitter/grammars/tree-sitter-xeto.wasm"

  if [ -f "$wasm_grammar" ]; then
    local size
    size=$(wc -c < "$wasm_grammar" | tr -d ' ')
    echo -e "  ${GREEN}OK${NC}  WASM binary: $wasm_grammar (${size} bytes)"
  else
    echo -e "  ${RED}MISSING${NC}  WASM binary not built. Run: cd tree-sitter-xeto && tree-sitter build --wasm"
  fi

  if [ -f "$wasm_installed" ]; then
    local size
    size=$(wc -c < "$wasm_installed" | tr -d ' ')
    echo -e "  ${GREEN}OK${NC}  Installed WASM: grammars/tree-sitter-xeto.wasm (${size} bytes)"
  else
    echo -e "  ${RED}MISSING${NC}  WASM not installed in grammars/. Copy with:"
    echo "         cp tree-sitter-xeto/tree-sitter-xeto.wasm src/parser/treeSitter/grammars/"
  fi
}

# ============================================================================
# Phase 4: Registration check
# ============================================================================

check_registration() {
  print_header "Phase 4: MCP Server Registration"

  local checks=0
  local passed=0

  # Check types.ts
  checks=$((checks + 1))
  if grep -q "'xeto'" "$PROJECT_DIR/src/parser/treeSitter/types.ts" 2>/dev/null; then
    echo -e "  ${GREEN}OK${NC}  types.ts — 'xeto' in SupportedLanguage"
    passed=$((passed + 1))
  else
    echo -e "  ${RED}MISSING${NC}  types.ts — 'xeto' not in SupportedLanguage union"
  fi

  # Check languageRegistry.ts
  checks=$((checks + 1))
  if grep -q "xetoMappings" "$PROJECT_DIR/src/parser/treeSitter/languageRegistry.ts" 2>/dev/null; then
    echo -e "  ${GREEN}OK${NC}  languageRegistry.ts — xetoMappings defined"
    passed=$((passed + 1))
  else
    echo -e "  ${RED}MISSING${NC}  languageRegistry.ts — xetoMappings not defined"
  fi

  # Check grammarDownloader.ts
  checks=$((checks + 1))
  if grep -q "tree-sitter-xeto.wasm" "$PROJECT_DIR/src/parser/treeSitter/grammarDownloader.ts" 2>/dev/null; then
    echo -e "  ${GREEN}OK${NC}  grammarDownloader.ts — xeto grammar source registered"
    passed=$((passed + 1))
  else
    echo -e "  ${RED}MISSING${NC}  grammarDownloader.ts — xeto not registered"
  fi

  # Check treeSitterAdapter.ts
  checks=$((checks + 1))
  if grep -q "xeto" "$PROJECT_DIR/src/fantom-code/treeSitterAdapter.ts" 2>/dev/null; then
    echo -e "  ${GREEN}OK${NC}  treeSitterAdapter.ts — .xeto extension mapped"
    passed=$((passed + 1))
  else
    echo -e "  ${RED}MISSING${NC}  treeSitterAdapter.ts — .xeto not mapped"
  fi

  echo ""
  echo -e "  Registration: ${passed}/${checks} checks passed"
}

# ============================================================================
# Main
# ============================================================================

main() {
  check_prereqs

  echo -e "${BOLD}${CYAN}"
  echo "  ╔═══════════════════════════════════════════╗"
  echo "  ║    Tree-sitter-xeto Grammar Test Suite    ║"
  echo "  ╚═══════════════════════════════════════════╝"
  echo -e "${NC}"

  local mode="${1:-all}"

  case "$mode" in
    --corpus-only)
      run_corpus_tests
      ;;
    --parse-only)
      run_parse_validation
      ;;
    --file)
      if [ -z "${2:-}" ]; then
        echo -e "${RED}Usage: $0 --file <path.xeto>${NC}"
        exit 1
      fi
      cd "$GRAMMAR_DIR"
      tree-sitter generate 2>/dev/null
      echo -e "${CYAN}Parsing: $2${NC}"
      tree-sitter parse "$2" 2>&1
      ;;
    --check)
      check_wasm
      check_registration
      ;;
    all|*)
      run_corpus_tests
      run_parse_validation
      check_wasm
      check_registration

      print_header "Summary"
      echo -e "  Corpus tests:   ${GREEN}All passed${NC}"
      if [ $TOTAL -gt 0 ]; then
        echo -e "  Real files:     ${PASS}/${TOTAL} passed (${FAIL} failures)"
      fi
      echo ""
      ;;
  esac
}

main "$@"
