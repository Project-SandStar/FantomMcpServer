/**
 * Tree-sitter grammar for the Trio record format (Project Haystack / Haxall).
 *
 * Derived from haxall src/core/haystack/fan/TrioReader.fan:
 *   - a line starting with "-" ends the current record
 *   - blank lines and "//" lines are skipped
 *   - "name"            marker tag
 *   - "name: value"     scalar tag, value is a Zinc literal
 *   - "name:"           value is the following indented text block
 *   - "name: Zinc:"     indented block holds a Zinc grid
 *   - "name: Trio:"     indented block holds a nested Trio record
 *   - "name: ["         indented block holds list items
 *
 * Newlines are significant, so they are explicit tokens and only
 * horizontal whitespace is an extra. The indented block is a single token
 * that starts with the newline after the colon and swallows every following
 * line that is blank or begins with whitespace, matching readIndentedText.
 *
 * The `src` tag of an Axon function record holds Axon source; see
 * queries/injections.scm and the ast-grep languageInjections entry.
 */
module.exports = grammar({
  name: "trio",

  extras: ($) => [/[ \t\r]/, $.comment],

  rules: {
    source_file: ($) => seq(
      repeat(choice($._newline, $.separator)),
      repeat(seq($.record, repeat(choice($._newline, $.separator)))),
    ),

    record: ($) => prec.right(seq(
      $._line,
      repeat(choice($._line, $._newline)),
    )),

    // A scalar tag must end with a newline. Making it optional would let
    // "a b c" parse as three marker tags instead of an error, so a file whose
    // last line is a bare tag without a newline is the caller's job to
    // normalise (parseTrio in the indexer appends one). indented_text does
    // tolerate EOF without a newline, since that is unambiguous.
    _line: ($) => choice(
      seq($.tag, $._newline),
      $.block_tag,
    ),

    // name            -> marker
    // name: scalar
    tag: ($) => seq(
      field("name", $.name),
      optional(seq(":", field("value", $._scalar))),
    ),

    // name:            indented text
    // name: Zinc:      indented zinc grid
    // name: Trio:      indented nested record
    // name: [          indented list
    // name: {          indented dict (lenient, see dict_block)
    block_tag: ($) => seq(
      field("name", $.name),
      ":",
      field("kind", optional(choice($.zinc_block, $.trio_block, $.list_block, $.dict_block))),
      field("value", $.indented_text),
    ),

    zinc_block: (_) => "Zinc:",
    trio_block: (_) => "Trio:",
    list_block: (_) => "[",
    // "{" alone on the line with an indented body. TrioReader itself rejects
    // this, but it appears in rule-definition exports, so accept it.
    dict_block: (_) => "{",

    separator: (_) => token(prec(1, /-[^\r\n]*/)),

    name: (_) => /[a-z_][a-zA-Z0-9_]*/,

    _scalar: ($) => choice(
      $.ref,
      $.symbol,
      $.str,
      $.uri,
      $.date_time,
      $.date,
      $.time,
      $.number,
      $.bool,
      $.na,
      $.remove,
      $.list,
      $.dict,
      $.xstr,
      $.raw,
    ),

    // @id or @id "display"
    ref: (_) => /@[a-zA-Z0-9_:.~-]+([ \t]+"([^"\\\n]|\\.)*")?/,
    symbol: (_) => /\^[a-zA-Z0-9_:.~-]+/,
    // Zinc strings are single-line and TrioReader rejects a quote that does not
    // close on its line. SkySpark project exports (proj/*/func/*.trio) still
    // write help/doc/src as one quoted literal spanning lines, so accept a
    // newline inside the quotes rather than error on hundreds of real files.
    str: (_) => /"([^"\\]|\\.)*"/,
    uri: (_) => /`[^`\n]*`/,
    date_time: (_) => /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?([ \t]+[A-Za-z_][A-Za-z0-9_+-]*)?/,
    date: (_) => /\d{4}-\d{2}-\d{2}/,
    time: (_) => /\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?/,
    // decimal or hex, optional unit (letters, %, $, /, unicode > 127)
    number: (_) => /-?(0x[0-9a-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)(_?[a-zA-Z%$\/°-￿][a-zA-Z0-9%$\/_°-￿]*)?|NaN|INF|-INF/,
    bool: (_) => choice("true", "false", "T", "F"),
    na: (_) => "NA",
    remove: (_) => "R",
    list: (_) => /\[[^\r\n]*\]/,
    dict: (_) => /\{[^\r\n]*\}/,
    // Coord(1,2), Bin("text/plain"), XStr("...") and other Type(...) literals
    xstr: (_) => /[A-Z][a-zA-Z0-9_]*\([^\r\n]*\)/,
    // Anything else up to end of line: TrioReader returns the raw Str for any
    // value containing a space, and for unknown words. Same lexical precedence
    // as the keyword tokens so that longest-match wins ("falseToTrue" is raw,
    // "false" is bool by string-over-regex specificity).
    raw: (_) => /[^\s\[{"`@^-][^\r\n]*/,

    // newline right after "name:" plus every following line that is blank or indented
    // TrioReader.readIndentedText keeps a line while it is blank, starts with
    // whitespace, or is a single character (line.size > 1 check), e.g. a lone "]".
    // The final indented line may end at EOF without a newline. Only an
    // indented line is allowed there: a bare single character would let the
    // token eat the first "-" of a "---" separator.
    indented_text: (_) => token(prec(1, /\r?\n((?:[ \t]+[^\n]*|[^\s])?\r?\n)*([ \t]+[^\n]*)?/)),

    comment: (_) => token(prec(2, /\/\/[^\r\n]*/)),

    _newline: (_) => /\r?\n/,
  },
});
