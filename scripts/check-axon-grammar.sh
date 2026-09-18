#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
# check-axon-grammar.sh — Test tree-sitter-axon grammar against Axon files
#
# Usage:
#   ./scripts/check-axon-grammar.sh [AXON_DIR]
#
# Default AXON_DIR: ~/axon-library
#
# Outputs:
#   - Summary of passed/failed files
#   - List of failing files with error details
#   - Exit code 0 if all pass, 1 if any failures
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

AXON_DIR="${1:-~/axon-library}"
GRAMMAR_DIR="$(cd "$(dirname "$0")/../tree-sitter-axon" && pwd)"

if [ ! -d "$AXON_DIR" ]; then
  echo "Error: Axon directory not found: $AXON_DIR"
  exit 2
fi

if [ ! -f "$GRAMMAR_DIR/grammar.js" ]; then
  echo "Error: tree-sitter-axon grammar not found at: $GRAMMAR_DIR"
  exit 2
fi

cd "$GRAMMAR_DIR"

FAILED=0
PASSED=0
TOTAL=0
FAIL_DETAILS=""

echo "Testing tree-sitter-axon grammar against Axon files in:"
echo "  $AXON_DIR"
echo ""

while IFS= read -r f; do
  TOTAL=$((TOTAL + 1))
  result=$(tree-sitter parse "$f" 2>&1 || true)
  if echo "$result" | grep -q "ERROR\|MISSING"; then
    FAILED=$((FAILED + 1))
    error_line=$(echo "$result" | grep 'ERROR\|MISSING' | head -1 | sed 's/^[[:space:]]*//')
    rel_path="${f#$AXON_DIR/}"
    FAIL_DETAILS="${FAIL_DETAILS}  FAIL: ${rel_path}\n        ${error_line}\n"
  else
    PASSED=$((PASSED + 1))
  fi

  # Progress indicator every 100 files
  if [ $((TOTAL % 100)) -eq 0 ]; then
    echo -ne "\r  Progress: $TOTAL files tested..."
  fi
done < <(find "$AXON_DIR" -name '*.axon' | sort)

echo -ne "\r"
echo "─────────────────────────────────────────────"
echo "Results: $PASSED/$TOTAL passed, $FAILED failed"
echo "─────────────────────────────────────────────"

if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo "Failing files:"
  echo -e "$FAIL_DETAILS"
  exit 1
else
  echo "All files parsed successfully!"
  exit 0
fi
