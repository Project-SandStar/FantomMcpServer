/**
 * External scanner for the Fantom tree-sitter grammar.
 *
 * COMMENT: nested slash-star block comments (the line form stays in grammar.js).
 * Fantom block comments nest
 * (Tokenizer.fan skipCommentML keeps a depth counter), which a regular
 * expression cannot express. Everything else stays in grammar.js.
 */
#include "tree_sitter/parser.h"
#include <stdbool.h>

enum TokenType {
  COMMENT,
  LBRACKET_SAME_LINE,
  SAME_LINE,
  CLOSURE_AHEAD,
};

void *tree_sitter_fantom_external_scanner_create(void) { return NULL; }
void tree_sitter_fantom_external_scanner_destroy(void *payload) {}
unsigned tree_sitter_fantom_external_scanner_serialize(void *payload, char *buffer) { return 0; }
void tree_sitter_fantom_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {}

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }
static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

bool tree_sitter_fantom_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  if (!valid_symbols[COMMENT] && !valid_symbols[LBRACKET_SAME_LINE] &&
      !valid_symbols[SAME_LINE] && !valid_symbols[CLOSURE_AHEAD]) return false;

  bool newline = false;
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t' ||
         lexer->lookahead == '\n' || lexer->lookahead == '\r') {
    if (lexer->lookahead == '\n' || lexer->lookahead == '\r') newline = true;
    skip(lexer);
  }

  // Zero-width: an identifier starts on the same line as the previous token.
  if (valid_symbols[SAME_LINE] && !newline &&
      ((lexer->lookahead >= 'a' && lexer->lookahead <= 'z') ||
       (lexer->lookahead >= 'A' && lexer->lookahead <= 'Z') ||
       lexer->lookahead == '_')) {
    lexer->mark_end(lexer);
    lexer->result_symbol = SAME_LINE;
    return true;
  }

  // `[` on the same line as the previous token and not the `[]` list suffix.
  if (valid_symbols[LBRACKET_SAME_LINE] && lexer->lookahead == '[' && !newline) {
    advance(lexer);
    if (lexer->lookahead == ']') return false;
    lexer->mark_end(lexer);
    lexer->result_symbol = LBRACKET_SAME_LINE;
    return true;
  }

  // Zero-width CLOSURE_AHEAD: `|` ... `|` then optional whitespace then `{`.
  // Nested func types (`|A a, |B->C| f|`) open after `|`, `,` or `>`.
  if (valid_symbols[CLOSURE_AHEAD] && lexer->lookahead == '|') {
    lexer->mark_end(lexer);
    advance(lexer);
    if (lexer->lookahead == '|') return false;  // `||` is the or operator
    int depth = 1;
    int32_t prev = '|';
    while (depth > 0) {
      int32_t c = lexer->lookahead;
      if (c == 0 || c == '{' || c == '}' || c == ';' || c == '"' || c == '\'' || c == '`') return false;
      if (c == '|') {
        if (prev == '|' || prev == ',' || prev == '>') depth++; else depth--;
      }
      if (c != ' ' && c != '\t' && c != '\n' && c != '\r') prev = c;
      advance(lexer);
    }
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t' ||
           lexer->lookahead == '\n' || lexer->lookahead == '\r') advance(lexer);
    if (lexer->lookahead != '{') return false;
    lexer->result_symbol = CLOSURE_AHEAD;
    return true;
  }

  if (!valid_symbols[COMMENT]) return false;
  if (lexer->lookahead != '/') return false;
  advance(lexer);
  if (lexer->lookahead != '*') return false;
  advance(lexer);

  int depth = 1;
  while (depth > 0) {
    if (lexer->eof(lexer)) return false;
    if (lexer->lookahead == '*') {
      advance(lexer);
      if (lexer->lookahead == '/') { advance(lexer); depth--; }
    } else if (lexer->lookahead == '/') {
      advance(lexer);
      if (lexer->lookahead == '*') { advance(lexer); depth++; }
    } else {
      advance(lexer);
    }
  }

  lexer->result_symbol = COMMENT;
  lexer->mark_end(lexer);
  return true;
}
