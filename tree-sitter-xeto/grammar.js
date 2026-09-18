/**
 * Tree-sitter grammar for the Xeto data type language.
 *
 * Xeto is the type definition language used by Project Haystack / Haxall
 * for defining ontologies, specs (type definitions), instances, and data
 * schemas. This grammar is derived from the official Xeto compiler source
 * (Tokenizer.fan, Parser.fan, Token.fan).
 *
 * Key language characteristics:
 *   - Newlines are significant as separators (like commas)
 *   - CamelCase identifiers are type references; camelCase are names/markers
 *   - `<>` delimiters enclose metadata blocks
 *   - `{}` delimiters enclose spec bodies (slots) and dict literals
 *   - `?` suffix marks nullable types
 *   - `&` / `|` create compound (AND/OR) types
 *   - `::` separates library from type in qualified names
 *   - `.` separates dotted path segments
 *   - `+` prefix marks mixin definitions
 *   - `*` prefix marks global slots
 *   - `@` prefix marks instance refs
 *   - `---` delimiters enclose heredoc content
 *   - Triple-quoted strings for multiline
 *   - Block comments can be nested
 *
 * External scanner tokens (implemented in src/scanner.c):
 *   - _triple_string_content — content between triple quotes
 *   - _heredoc_content — content between --- delimiters
 *   - block_comment — nested block comments
 */
module.exports = grammar({
  name: "xeto",

  externals: ($) => [
    $._triple_string_content,
    $._heredoc_content,
    $.block_comment,
  ],

  extras: ($) => [/[ \t\r]/, $.comment, $.block_comment],

  word: ($) => $.identifier,

  conflicts: ($) => [
    [$.slot_def, $.marker_slot],
    [$.marker_slot],
    [$.unnamed_slot],
    [$.spec_def],
    [$.body, $.dict_literal],
  ],

  rules: {
    // ========================================================================
    // Root
    // ========================================================================

    source_file: ($) =>
      repeat(
        choice(
          $.pragma,
          $.spec_def,
          $.mixin_def,
          $.instance_def,
          $._newline
        )
      ),

    _newline: (_$) => /\n/,

    _sep: ($) => choice(",", $._newline),

    // ========================================================================
    // Pragma: pragma: Lib < ... >
    // ========================================================================

    pragma: ($) =>
      seq("pragma", ":", field("type", $.type_ref), field("meta", $.meta_block)),

    // ========================================================================
    // Spec Definition: Name [: Type] [<meta>] [{ body } | "scalar"]
    // ========================================================================

    spec_def: ($) =>
      seq(
        field("name", alias($._upper_id, $.identifier)),
        optional(seq(":", optional(field("type", $._type_expr)))),
        optional(field("meta", $.meta_block)),
        optional(choice(field("body", $.body), field("val", $._scalar_val)))
      ),

    // ========================================================================
    // Mixin Definition: +Type <meta> { body }
    // ========================================================================

    mixin_def: ($) =>
      seq(
        "+",
        field("type", $._type_expr),
        optional(field("meta", $.meta_block)),
        optional(field("body", $.body))
      ),

    // ========================================================================
    // Instance Definition: @ref [: Type] [<meta>] { body }
    // ========================================================================

    instance_def: ($) =>
      seq(
        field("id", $.ref_literal),
        optional(seq(":", optional(field("type", $._type_expr)))),
        optional(field("meta", $.meta_block)),
        field("body", $.body)
      ),

    // ========================================================================
    // Type Expressions
    // ========================================================================

    _type_expr: ($) =>
      choice($.nullable_type, $.compound_type, $._type_atom),

    _type_atom: ($) => choice($.type_ref, $.qualified_name),

    // Simple type ref: CamelCase or dotted path
    type_ref: ($) =>
      choice(alias($._upper_id, $.identifier), $.dotted_name),

    // Dotted name: a.b.c (path segments for unqualified dotted refs)
    dotted_name: ($) =>
      prec.left(
        2,
        seq(
          choice($._upper_id, $._lower_id),
          repeat1(seq(".", choice($._upper_id, $._lower_id)))
        )
      ),

    // Qualified name: lib::Name or lib.sub::Name
    // lib can be a simple name (e.g. ph::Site) or dotted (e.g. hx.test::Foo)
    qualified_name: ($) =>
      prec(
        3,
        seq(
          field("lib", choice($.dotted_name, alias($._lower_id, $.identifier))),
          "::",
          field("name", alias($._upper_id, $.identifier))
        )
      ),

    // Nullable type: Type?
    nullable_type: ($) =>
      prec(5, seq($._type_atom, "?")),

    // Compound type: A & B or A | B (can chain)
    compound_type: ($) =>
      prec.left(
        1,
        seq(
          $._type_atom,
          choice("&", "|"),
          choice($._type_atom, $.compound_type)
        )
      ),

    // ========================================================================
    // Meta Block: < ... >
    // ========================================================================

    meta_block: ($) =>
      seq(
        "<",
        repeat(choice($.meta_tag, $._sep)),
        ">"
      ),

    // Single meta tag: marker or key:value
    meta_tag: ($) =>
      prec.right(
        choice(
          seq(
            field("key", alias($._lower_id, $.identifier)),
            ":",
            field("value", $._meta_val)
          ),
          field("key", alias($._lower_id, $.identifier))
        )
      ),

    _meta_val: ($) =>
      choice(
        $._scalar_val,
        $._type_expr,
        $.body,
        $.dict_literal,
        $.ref_literal,
        $.typed_scalar,
        $.build_var
      ),

    // ========================================================================
    // Body Block: { ... }
    // ========================================================================

    body: ($) =>
      seq(
        "{",
        repeat(
          choice(
            $.slot_def,
            $.marker_slot,
            $.unnamed_slot,
            $.inline_meta,
            $.instance_def,
            $.dict_literal,
            $._scalar_val,
            $._sep
          )
        ),
        "}"
      ),

    // ========================================================================
    // Slots
    // ========================================================================

    // Named slot: [*] name : [Type] [<meta>] [{ body } | "scalar"]
    slot_def: ($) =>
      prec.right(
        2,
        seq(
          optional(field("global", $.global_prefix)),
          field("name", alias($._lower_id, $.identifier)),
          ":",
          optional(field("type", $._type_expr)),
          optional(field("meta", $.meta_block)),
          optional(choice(field("body", $.body), field("val", $._scalar_val)))
        )
      ),

    // Marker slot: lowercase id without colon
    marker_slot: ($) =>
      prec(
        -1,
        seq(
          optional(field("global", $.global_prefix)),
          field("name", alias($._lower_id, $.identifier)),
          optional(field("meta", $.meta_block))
        )
      ),

    // Unnamed slot: CamelCase type ref with optional meta/body/scalar
    unnamed_slot: ($) =>
      prec(
        1,
        seq(
          field("type", $._type_expr),
          optional(field("meta", $.meta_block)),
          optional(choice(field("body", $.body), field("val", $._scalar_val)))
        )
      ),

    // Inline meta: <tag> inside body (not attached to a slot)
    inline_meta: ($) => $.meta_block,

    // Global prefix: * before slot name
    global_prefix: (_$) => "*",

    // ========================================================================
    // Dict Literal: { key: val, ... }
    // ========================================================================

    dict_literal: ($) =>
      seq(
        "{",
        repeat(choice($.dict_entry, $._sep)),
        "}"
      ),

    dict_entry: ($) =>
      prec.right(
        choice(
          seq(
            field("key", alias($._lower_id, $.identifier)),
            ":",
            field("value", $._dict_val)
          ),
          field("key", alias($._lower_id, $.identifier))
        )
      ),

    _dict_val: ($) =>
      choice(
        $._scalar_val,
        $.dict_literal,
        $.ref_literal,
        $._type_expr,
        $.typed_scalar,
        $.build_var
      ),

    // ========================================================================
    // Scalar Values
    // ========================================================================

    _scalar_val: ($) =>
      choice($.string_literal, $.triple_string, $.number_literal, $.heredoc),

    // Regular quoted string: "content" with escape sequences
    string_literal: (_$) =>
      token(seq('"', repeat(choice(/[^"\\]/, seq("\\", /./))), '"')),

    // Triple-quoted string: """content"""
    triple_string: ($) =>
      seq('"""', optional($._triple_string_content), '"""'),

    // Number with optional unit: 123, 5min, 90kW, 24V, 3.14
    number_literal: (_$) =>
      token(
        seq(
          optional("-"),
          /[0-9]+/,
          optional(seq(".", /[0-9]+/)),
          optional(seq(/[eE]/, optional(/[+-]/), /[0-9]+/)),
          optional(/[a-zA-Z_%$\u00B0][a-zA-Z0-9_%$\/\u00B0]*/)
        )
      ),

    // Heredoc: ---\ncontent\n---
    heredoc: ($) => seq("---", optional($._heredoc_content), "---"),

    // ========================================================================
    // Typed Scalar and BuildVar
    // ========================================================================

    // Typed scalar: Type "value" (e.g., Date "2024-01-01", Duration "5min")
    typed_scalar: ($) =>
      prec(
        4,
        seq(field("type", $._type_atom), field("val", $.string_literal))
      ),

    // Build variable: BuildVar "var.name"
    build_var: ($) => seq("BuildVar", field("val", $.string_literal)),

    // ========================================================================
    // Ref Literal
    // ========================================================================

    // @id reference: @name, @lib-name, @root
    ref_literal: (_$) => token(seq("@", /[a-zA-Z0-9_:.~-]+/)),

    // ========================================================================
    // Identifiers
    // ========================================================================

    // Lowercase identifier (tags, slot names, markers)
    _lower_id: (_$) => /[a-z_][a-zA-Z0-9_]*/,

    // Uppercase identifier (type names, spec names)
    _upper_id: (_$) => /[A-Z][a-zA-Z0-9_]*/,

    // Generic identifier (word token target)
    identifier: (_$) => /[a-zA-Z_][a-zA-Z0-9_]*/,

    // ========================================================================
    // Comments
    // ========================================================================

    // Single-line comment
    comment: (_$) => token(seq("//", /[^\n]*/)),
  },
});
