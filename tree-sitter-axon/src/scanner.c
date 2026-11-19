/**
 * External scanner for Axon tree-sitter grammar.
 *
 * Produces four tokens:
 *
 * 1. BLOCK_COMMENT — nested slash-star comments, mirroring
 *    Tokenizer.fan skipCommentML(): depth counting on "/ *" and "* /",
 *    and an unterminated comment runs to end of file (cur == 0 → break).
 *    Tree-sitter token regexes cannot nest, so this lives here.
 *
 * 2. TRAILING_LAMBDA_AHEAD — detects trailing lambda after a call's closing
 *    paren on the same line. Matches Parser.fan call() lines 646-648:
 *      if (!isEos && (cur === Token.id || cur === Token.lparen))
 *        args.add(lamdba)
 *
 * 3. INDEX_AHEAD — detects [ on the same line for index expressions.
 *    Prevents newline-separated [list] from being misinterpreted as
 *    index access on the preceding expression.
 *    Matches Haxall's isEos — after a newline, [ starts a new expression.
 *
 * 4. IMPLICIT_END — zero-width token before "else" or "catch": Parser.fan
 *    doBlock() breaks on those keywords without consuming an "end".
 *
 * Tokens 2, 3 and 4 are zero-width (mark_end called before any advance).
 */

#include "tree_sitter/parser.h"
#include <stdbool.h>

enum TokenType {
  TRAILING_LAMBDA_AHEAD,
  INDEX_AHEAD,
  BLOCK_COMMENT,
  IMPLICIT_END,
  ELSE_KEYWORD,   // never produced here; valid_symbols probe only
  CATCH_KEYWORD,  // never produced here; valid_symbols probe only
};

// No scanner state needed
void *tree_sitter_axon_external_scanner_create(void) { return NULL; }
void tree_sitter_axon_external_scanner_destroy(void *payload) {}
unsigned tree_sitter_axon_external_scanner_serialize(void *payload, char *buffer) { return 0; }
void tree_sitter_axon_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {}

static inline bool is_alpha(int32_t c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

static inline bool is_id_start(int32_t c) {
  return (c >= 'a' && c <= 'z') || c == '_';
}

static inline bool is_id_char(int32_t c) {
  return is_alpha(c) || (c >= '0' && c <= '9') || c == '_';
}

static inline bool is_blank(int32_t c) {
  return c == ' ' || c == '\t';
}

static inline bool is_newline(int32_t c) {
  return c == '\n' || c == '\r';
}

// Tokenizer.fan skipCommentML(): "/*" already consumed, depth starts at 1.
static bool scan_block_comment(TSLexer *lexer) {
  int depth = 1;
  while (depth > 0) {
    if (lexer->eof(lexer)) break;  // unterminated: comment runs to EOF
    if (lexer->lookahead == '*') {
      lexer->advance(lexer, false);
      if (lexer->lookahead == '/') { lexer->advance(lexer, false); depth--; }
    } else if (lexer->lookahead == '/') {
      lexer->advance(lexer, false);
      if (lexer->lookahead == '*') { lexer->advance(lexer, false); depth++; }
    } else {
      lexer->advance(lexer, false);
    }
  }
  lexer->mark_end(lexer);
  lexer->result_symbol = BLOCK_COMMENT;
  return true;
}

bool tree_sitter_axon_external_scanner_scan(
  void *payload,
  TSLexer *lexer,
  const bool *valid_symbols
) {
  if (!valid_symbols[TRAILING_LAMBDA_AHEAD] && !valid_symbols[INDEX_AHEAD] &&
      !valid_symbols[BLOCK_COMMENT] && !valid_symbols[IMPLICIT_END]) {
    return false;
  }

  // Skip whitespace (not part of any token); remember if a newline passed.
  bool saw_newline = false;
  while (is_blank(lexer->lookahead) || is_newline(lexer->lookahead)) {
    if (is_newline(lexer->lookahead)) saw_newline = true;
    lexer->advance(lexer, true);
  }

  // Block comment: starts at "/*". A lone "/" or "//" is left to the
  // internal lexer (tree-sitter rewinds when we return false).
  if (valid_symbols[BLOCK_COMMENT] && lexer->lookahead == '/') {
    lexer->advance(lexer, false);
    if (lexer->lookahead != '*') return false;
    lexer->advance(lexer, false);
    return scan_block_comment(lexer);
  }

  // Zero-width tokens: mark end before any further advance.
  lexer->mark_end(lexer);

  // Implicit block end: Parser.fan doBlock() breaks on "else" / "catch"
  // without consuming "end". Comments before the keyword are consumed as
  // extras by earlier scans, so only the keyword itself is checked here.
  // When the keyword itself is valid here an enclosing if/try is still
  // open and takes it (dangling else binds to the nearest if), so no
  // implicit end is produced; the internal lexer then lexes the keyword.
  if (valid_symbols[IMPLICIT_END] &&
      ((lexer->lookahead == 'e' && !valid_symbols[ELSE_KEYWORD]) ||
       (lexer->lookahead == 'c' && !valid_symbols[CATCH_KEYWORD]))) {
    const char *kw = lexer->lookahead == 'e' ? "else" : "catch";
    bool match = true;
    for (const char *k = kw; *k; k++) {
      if (lexer->lookahead != *k) { match = false; break; }
      lexer->advance(lexer, false);
    }
    if (match && !is_id_char(lexer->lookahead)) {
      lexer->result_symbol = IMPLICIT_END;
      return true;
    }
    return false;
  }

  if (!valid_symbols[TRAILING_LAMBDA_AHEAD] && !valid_symbols[INDEX_AHEAD]) {
    return false;
  }

  // Newline or EOF means isEos — no same-line token
  if (saw_newline || lexer->lookahead == 0 || lexer->eof(lexer)) {
    return false;
  }

  // Check for [ on the same line
  if (valid_symbols[INDEX_AHEAD] && lexer->lookahead == '[') {
    lexer->result_symbol = INDEX_AHEAD;
    return true;
  }

  // Check for trailing lambda
  if (valid_symbols[TRAILING_LAMBDA_AHEAD]) {
    // Case 1: parenthesized params: (a, b) => or () =>
    if (lexer->lookahead == '(') {
      lexer->advance(lexer, false);
      int depth = 1;

      // Find matching close paren
      while (depth > 0 && lexer->lookahead != 0) {
        if (lexer->lookahead == '(') {
          depth++;
        } else if (lexer->lookahead == ')') {
          depth--;
        }

        if (depth > 0) {
          lexer->advance(lexer, false);
        }
      }

      if (depth != 0) return false;  // unbalanced parens

      // Advance past the closing paren
      lexer->advance(lexer, false);

      // Skip spaces
      while (is_blank(lexer->lookahead)) {
        lexer->advance(lexer, false);
      }

      // Check for =>
      if (lexer->lookahead == '=') {
        lexer->advance(lexer, false);
        if (lexer->lookahead == '>') {
          lexer->result_symbol = TRAILING_LAMBDA_AHEAD;
          return true;
        }
      }

      return false;
    }

    // Case 2: bare identifier param: x =>
    if (is_id_start(lexer->lookahead)) {
      // Consume identifier
      while (is_id_char(lexer->lookahead)) {
        lexer->advance(lexer, false);
      }

      // Skip spaces
      while (is_blank(lexer->lookahead)) {
        lexer->advance(lexer, false);
      }

      // Check for =>
      if (lexer->lookahead == '=') {
        lexer->advance(lexer, false);
        if (lexer->lookahead == '>') {
          lexer->result_symbol = TRAILING_LAMBDA_AHEAD;
          return true;
        }
      }

      return false;
    }
  }

  return false;
}
