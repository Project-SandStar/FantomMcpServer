/**
 * External scanner for tree-sitter-xeto.
 *
 * Handles tokens that tree-sitter's built-in lexer cannot:
 *   1. Triple-quoted strings ("""...""") with embedded quotes
 *   2. Heredoc strings (---\n...\n---) with variable dash count
 *   3. Nested block comments (slash-star ... slash-star ... star-slash ... star-slash)
 *
 * Derived from the official Xeto Tokenizer.fan.
 */

#include "tree_sitter/parser.h"
#include <stdbool.h>

enum TokenType {
  TRIPLE_STRING_CONTENT,
  HEREDOC_CONTENT,
  BLOCK_COMMENT,
};

// ============================================================================
// Scanner lifecycle (stateless — no serialize/deserialize needed)
// ============================================================================

void *tree_sitter_xeto_external_scanner_create(void) { return NULL; }
void tree_sitter_xeto_external_scanner_destroy(void *payload) { (void)payload; }
unsigned tree_sitter_xeto_external_scanner_serialize(void *payload, char *buffer) {
  (void)payload; (void)buffer;
  return 0;
}
void tree_sitter_xeto_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  (void)payload; (void)buffer; (void)length;
}

// ============================================================================
// Helper: advance and consume character into token
// ============================================================================

static inline void advance(TSLexer *lexer) {
  lexer->advance(lexer, false);
}

static inline void skip_ws(TSLexer *lexer) {
  lexer->advance(lexer, true);
}

// ============================================================================
// Triple-quoted string content
//
// The grammar consumes the opening """. This scanner reads everything
// up to (but not including) the closing """.
// Handles:
//   - Embedded single " or "" that are NOT followed by another "
//   - Escape sequences (\n, \", \\, \uXXXX, etc.)
//   - Newlines within the string
// ============================================================================

static bool scan_triple_string(TSLexer *lexer) {
  bool has_content = false;

  while (!lexer->eof(lexer)) {
    if (lexer->lookahead == '"') {
      // Check for closing """
      lexer->mark_end(lexer);
      advance(lexer);
      if (lexer->lookahead == '"') {
        advance(lexer);
        if (lexer->lookahead == '"') {
          // Found closing """ — don't consume it, mark end before
          lexer->result_symbol = TRIPLE_STRING_CONTENT;
          return has_content;
        }
        // Just "" — part of content, continue
        has_content = true;
      } else {
        // Just " — part of content
        has_content = true;
      }
    } else if (lexer->lookahead == '\\') {
      // Escape sequence — consume backslash and next char
      has_content = true;
      advance(lexer);
      if (!lexer->eof(lexer)) {
        advance(lexer);
      }
    } else {
      has_content = true;
      advance(lexer);
    }
  }

  return false; // Unterminated string
}

// ============================================================================
// Heredoc content
//
// Opening: --- (3+ dashes) followed by optional spaces then newline.
// Content: everything until a line with the same number of dashes.
// Closing: matching --- (same count of dashes).
//
// The grammar consumes the opening "---". This scanner reads the rest
// of the opening (extra dashes, spaces, newline), then content, and
// stops before the closing dashes (which the grammar consumes).
// ============================================================================

static bool scan_heredoc(TSLexer *lexer) {
  // Count additional dashes beyond the 3 consumed by grammar
  int num_dashes = 3;
  while (lexer->lookahead == '-') {
    advance(lexer);
    num_dashes++;
  }

  // Skip optional spaces
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
    advance(lexer);
  }

  // Expect newline after opening dashes
  if (lexer->lookahead != '\n') {
    return false;
  }
  advance(lexer); // consume newline

  // Read content until we find matching closing dashes
  while (!lexer->eof(lexer)) {
    // At each position, check if we have num_dashes consecutive dashes
    if (lexer->lookahead == '-') {
      lexer->mark_end(lexer);

      int dash_count = 0;
      while (lexer->lookahead == '-' && dash_count < num_dashes) {
        advance(lexer);
        dash_count++;
      }

      if (dash_count == num_dashes) {
        // Found closing dashes — mark end before them
        lexer->result_symbol = HEREDOC_CONTENT;
        return true;
      }
      // Not enough dashes, this is content — continue
    } else {
      advance(lexer);
    }
  }

  return false; // Unterminated heredoc
}

// ============================================================================
// Nested block comment (with nesting support)
//
// Xeto explicitly supports nested block comments (unlike C/Java).
// This scanner handles arbitrary nesting depth.
// ============================================================================

static bool scan_block_comment(TSLexer *lexer) {
  // We should be positioned at the start. Check for /*
  if (lexer->lookahead != '/') return false;
  advance(lexer);
  if (lexer->lookahead != '*') return false;
  advance(lexer);

  int depth = 1;

  while (depth > 0 && !lexer->eof(lexer)) {
    if (lexer->lookahead == '/') {
      advance(lexer);
      if (lexer->lookahead == '*') {
        advance(lexer);
        depth++;
      }
    } else if (lexer->lookahead == '*') {
      advance(lexer);
      if (lexer->lookahead == '/') {
        advance(lexer);
        depth--;
      }
    } else {
      advance(lexer);
    }
  }

  if (depth == 0) {
    lexer->mark_end(lexer);
    lexer->result_symbol = BLOCK_COMMENT;
    return true;
  }

  return false; // Unterminated comment
}

// ============================================================================
// Main scanner entry point
// ============================================================================

bool tree_sitter_xeto_external_scanner_scan(
  void *payload,
  TSLexer *lexer,
  const bool *valid_symbols
) {
  (void)payload;

  // Try block comment first (highest priority when /* is seen)
  if (valid_symbols[BLOCK_COMMENT] && lexer->lookahead == '/') {
    return scan_block_comment(lexer);
  }

  // Try triple string content (after opening """ consumed by grammar)
  if (valid_symbols[TRIPLE_STRING_CONTENT]) {
    return scan_triple_string(lexer);
  }

  // Try heredoc content (after opening --- consumed by grammar)
  if (valid_symbols[HEREDOC_CONTENT]) {
    return scan_heredoc(lexer);
  }

  return false;
}
