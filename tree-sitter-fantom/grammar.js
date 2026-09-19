/**
 * Tree-sitter grammar for the Fantom programming language
 * https://fantom.org/
 *
 * Fantom is a portable language that runs on the JVM, .NET CLR, and JavaScript.
 */

module.exports = grammar({
  name: 'fantom',

  extras: $ => [
    /\s/,
    $.comment,
    $.doc_comment,
  ],

  word: $ => $.identifier,

  conflicts: $ => [
    [$.type_ref, $._primary],
    [$.enum_val, $.type_ref],
    [$.local_def, $.expr_stmt],
    [$._stmt, $.if_stmt],
    [$.simple_type, $._primary],
    [$.qualified_type_name, $._primary],
    [$.type_literal, $.slot_literal],
    [$.list_type, $.list_lit],
    [$.type_ref, $.nullable_type],
    [$.type_ref, $.list_type],
    [$.func_type, $.closure],
    [$.qualified_type_name, $.closure_param],
    [$.simple_type, $.shorthand_map_type],  // Str vs Str:Int
    [$.type_ref, $.shorthand_map_type],  // [Str:Int] vs Str:Int
    [$.closure_param, $.type_ref],  // |This| vs |This name|
    [$.func_type, $.closure_param],  // |Type,... vs |Type name|
    [$.qualified_type_name, $._arg],  // Type: vs name: in args
    [$.return_stmt],                   // `return` with/without expr (statement-boundary lookahead)
    [$._stmt, $.return_stmt],
  ],

  rules: {
    // ============================================
    // Top Level
    // ============================================
    source_file: $ => seq(
      repeat($.using_statement),
      repeat($._type_definition),
    ),

    // ============================================
    // Using Statements
    // ============================================
    using_statement: $ => seq(
      'using',
      field('path', $.dotted_name),
      optional(seq('as', field('alias', $.identifier))),
    ),

    dotted_name: $ => seq(
      $.identifier,
      repeat(seq(choice('.', '::'), $.identifier)),
    ),

    // ============================================
    // Type Definitions
    // ============================================
    _type_definition: $ => choice(
      $.class_definition,
      $.mixin_definition,
      $.enum_definition,
      $.facet_definition,
    ),

    class_definition: $ => seq(
      repeat($.facet),
      repeat($.modifier),
      'class',
      field('name', $.identifier),
      optional($.type_params),
      optional(seq(':', $.type_list)),
      field('body', $.class_body),
    ),

    mixin_definition: $ => seq(
      repeat($.facet),
      repeat($.modifier),
      'mixin',
      field('name', $.identifier),
      optional($.type_params),
      optional(seq(':', $.type_list)),
      field('body', $.class_body),
    ),

    enum_definition: $ => seq(
      repeat($.facet),
      repeat($.modifier),
      'enum',
      'class',
      field('name', $.identifier),
      optional(seq(':', $.type_list)),
      field('body', $.enum_body),
    ),

    facet_definition: $ => seq(
      repeat($.facet),
      repeat($.modifier),
      'facet',
      'class',
      field('name', $.identifier),
      optional(seq(':', $.type_list)),
      field('body', $.class_body),
    ),

    enum_body: $ => seq(
      '{',
      optional($.enum_vals),
      repeat($._slot),
      '}',
    ),

    enum_vals: $ => prec(2, seq(
      $.enum_val,
      repeat(seq(',', $.enum_val)),
    )),

    enum_val: $ => prec(2, seq(
      field('name', $.identifier),
      optional($.call_args),
    )),

    modifier: $ => choice(
      'abstract',
      'const',
      'final',
      'internal',
      'native',
      'once',
      'override',
      'private',
      'protected',
      'public',
      'readonly',
      'static',
      'virtual',
    ),

    type_params: $ => seq(
      '<',
      $.identifier,
      repeat(seq(',', $.identifier)),
      '>',
    ),

    type_list: $ => seq(
      $.type_ref,
      repeat(seq(',', $.type_ref)),
    ),

    class_body: $ => seq(
      '{',
      repeat($._slot),
      '}',
    ),

    // ============================================
    // Slots (Fields and Methods)
    // ============================================
    _slot: $ => choice(
      $.field_def,
      $.method_def,
      $.ctor_def,
      $.static_init,
    ),

    field_def: $ => seq(
      repeat($.facet),
      repeat($.modifier),
      field('type', $.type_ref),
      field('name', $.identifier),
      optional($.field_accessors),
      optional(seq(':=', field('init', $._expr))),
    ),

    field_accessors: $ => seq(
      '{',
      repeat(choice('get', 'set', $.block)),
      '}',
    ),

    method_def: $ => seq(
      repeat($.facet),
      repeat($.modifier),
      field('return_type', $.type_ref),
      field('name', $.identifier),
      field('params', $.param_list),
      optional(field('body', $.block)),
    ),

    ctor_def: $ => seq(
      repeat($.facet),
      repeat($.modifier),
      'new',
      field('name', $.identifier),
      field('params', $.param_list),
      optional(seq(':', $._ctor_chain)),
      optional(field('body', $.block)),
    ),

    _ctor_chain: $ => seq(
      choice('this', 'super'),
      $.call_args,
    ),

    static_init: $ => seq(
      'static',
      $.block,
    ),

    param_list: $ => seq(
      '(',
      optional(seq(
        $.param,
        repeat(seq(',', $.param)),
      )),
      ')',
    ),

    param: $ => seq(
      field('type', $.type_ref),
      field('name', $.identifier),
      optional(seq(':=', field('default', $._expr))),
    ),

    // ============================================
    // Types
    // ============================================
    type_ref: $ => choice(
      $.simple_type,
      $.nullable_type,
      $.list_type,
      $.map_type,
      $.shorthand_map_type,  // Key:Val without brackets
      $.func_type,
    ),

    simple_type: $ => prec.right(seq(
      $.qualified_type_name,
      optional($.type_args),
    )),

    qualified_type_name: $ => seq(
      $.identifier,
      repeat(seq('::', $.identifier)),
    ),

    // Nullable type can wrap any type form: `Foo?`, `Foo[]?`, `[Str:Int]?`,
    // `Func?`. Previously only wrapped `simple_type`, so common signatures
    // like `FacetDef[]? facets` failed to parse and cascaded into method-def
    // failure.
    nullable_type: $ => prec(2, seq(
      choice($.simple_type, $.list_type, $.map_type),
      '?',
    )),

    list_type: $ => prec.right(2, seq(
      choice($.simple_type, $.list_type),  // permit nested `Foo[][]`
      '[',
      ']',
    )),

    map_type: $ => seq(
      '[',
      field('key', $.type_ref),
      ':',
      field('val', $.type_ref),
      ']',
    ),

    // Shorthand map type without brackets: Str:Int, Str:Str:Obj
    // Used in field/variable declarations
    // Lower precedence than bracketed map_type
    shorthand_map_type: $ => prec.right(-1, seq(
      $.simple_type,
      ':',
      choice($.shorthand_map_type, $.simple_type),
    )),

    func_type: $ => seq(
      '|',
      optional(seq($.type_ref, repeat(seq(',', $.type_ref)))),
      '->',
      $.type_ref,
      '|',
    ),

    type_args: $ => seq(
      '<',
      $.type_ref,
      repeat(seq(',', $.type_ref)),
      '>',
    ),

    // ============================================
    // Facets
    // ============================================
    facet: $ => seq(
      '@',
      $.identifier,
      optional(seq(
        '{',
        optional(seq(
          $.facet_pair,
          repeat(seq(choice(',', ';'), $.facet_pair)),
        )),
        '}',
      )),
    ),

    facet_pair: $ => seq(
      $.identifier,
      '=',
      $._expr,
    ),

    // ============================================
    // Statements
    // ============================================
    // A block is `{ stmt sep stmt sep ... }` where sep is either a newline
    // (handled by `extras`) or an explicit `;`. Tokenizer.fan emits `;` as
    // Token.semicolon — required for multi-stmt-per-line idioms like
    // `{ consume; consumeId; consume(Token.rbracket) }`. Without this rule,
    // any Fantom source with `;` separators (Parser.fan, Tokenizer.fan, every
    // serious .fan file) falls into a top-level ERROR span.
    block: $ => seq(
      '{',
      repeat(';'),
      repeat(prec.left(seq($._stmt, repeat(';')))),
      '}',
    ),

    _stmt: $ => choice(
      $.local_def,
      $.return_stmt,
      $.throw_stmt,
      $.if_stmt,
      $.switch_stmt,
      $.while_stmt,
      $.for_stmt,
      $.try_stmt,
      $.break_stmt,
      $.continue_stmt,
      $.expr_stmt,
    ),

    // Local variable declaration. Fantom allows two forms:
    //   <type> <id> [":=" <expr>]      explicit type
    //                <id> ":=" <expr>   inferred type (very common)
    // Parser.fan disambiguates via tryType + backtrack — we use a plain choice
    // and rely on tree-sitter's GLR. Inferred form requires `:=` to distinguish
    // from a bare identifier expression.
    local_def: $ => prec(1, choice(
      seq(
        field('type', $.type_ref),
        field('name', $.identifier),
        optional(seq(':=', field('init', $._expr))),
      ),
      seq(
        field('name', $.identifier),
        ':=',
        field('init', $._expr),
      ),
    )),

    expr_stmt: $ => $._expr,

    // `return` with optional value. Without an external scanner emitting a
    // virtual newline/semicolon, `prec.right` made tree-sitter greedily fold
    // the next statement into the return value (e.g. `return\n    x := 5`
    // parsed `x := 5` as the return expression). Drop the prec.right; the
    // optional remains optional and tree-sitter's GLR picks the shorter
    // legal parse when the next tokens can't extend an expression.
    return_stmt: $ => seq('return', optional($._expr)),
    throw_stmt: $ => seq('throw', $._expr),
    break_stmt: $ => 'break',
    continue_stmt: $ => 'continue',

    if_stmt: $ => prec.right(seq(
      'if',
      '(',
      field('cond', $._expr),
      ')',
      field('then', choice($.block, $._stmt)),
      optional(seq('else', field('else', choice($.block, $._stmt, $.if_stmt)))),
    )),

    switch_stmt: $ => seq(
      'switch',
      '(',
      $._expr,
      ')',
      '{',
      repeat($.case_block),
      optional($.default_block),
      '}',
    ),

    // case body accepts the same statement-list shape as `block`: stmts
    // separated by newline OR `;`. Without `;` support here, idioms like
    // `case X: a = 1; b = true` (Parser.fan flag-decoder) fail.
    case_block: $ => seq('case', $._expr, ':',
      repeat(';'),
      repeat(prec.left(seq($._stmt, repeat(';')))),
    ),
    default_block: $ => seq('default', ':',
      repeat(';'),
      repeat(prec.left(seq($._stmt, repeat(';')))),
    ),

    while_stmt: $ => seq(
      'while',
      '(',
      $._expr,
      ')',
      choice($.block, $._stmt),
    ),

    // Fantom has BOTH foreach (`for (id in expr)`) and C-style
    // (`for (init; cond; update)`) loops. The original grammar only had
    // foreach, so any C-style `for (i := 0; i < n; ++i)` produced a
    // top-level parse failure that cascaded.
    for_stmt: $ => choice(
      seq('for', '(',
        choice($.local_def, $.identifier),
        'in', $._expr, ')',
        choice($.block, $._stmt),
      ),
      seq('for', '(',
        optional(choice($.local_def, $._expr)),
        ';',
        optional($._expr),
        ';',
        optional($._expr),
        ')',
        choice($.block, $._stmt),
      ),
    ),

    // Fantom allows a single statement in place of a braced block after
    // try / catch / finally.
    _try_body: $ => choice($.block, $._stmt),

    // prec.right binds catch/finally to the nearest try (dangling-else style).
    try_stmt: $ => prec.right(seq(
      'try',
      $._try_body,
      repeat($.catch_block),
      optional($.finally_block),
    )),

    catch_block: $ => seq(
      'catch',
      optional(seq('(', $.type_ref, $.identifier, ')')),
      $._try_body,
    ),

    finally_block: $ => seq('finally', $._try_body),

    // ============================================
    // Expressions
    // ============================================
    _expr: $ => choice(
      $.assign_expr,
      $.ternary_expr,
      $.elvis_expr,
      $.or_expr,
      $.and_expr,
      $.eq_expr,
      $.cmp_expr,
      $.type_check_expr,
      $.range_expr,
      $.add_expr,
      $.mul_expr,
      $.unary_expr,
      $.cast_expr,
      $.postfix_expr,
      $._primary,
    ),

    // Assignment expression. `:=` is intentionally NOT here — Fantom's `:=`
    // is *declaration* (always introduces a new local), so it lives only in
    // `local_def`. Including `:=` here causes ambiguity with `local_def` and
    // makes `protection := false` unparseable.
    assign_expr: $ => prec.right(1, seq(
      $._expr,
      choice('=', '+=', '-=', '*=', '/=', '%='),
      $._expr,
    )),

    ternary_expr: $ => prec.right(2, seq(
      $._expr,
      '?',
      $._expr,
      ':',
      $._expr,
    )),

    elvis_expr: $ => prec.right(3, seq(
      $._expr,
      '?:',
      $._expr,
    )),

    or_expr: $ => prec.left(4, seq($._expr, '||', $._expr)),
    and_expr: $ => prec.left(5, seq($._expr, '&&', $._expr)),
    eq_expr: $ => prec.left(6, seq($._expr, choice('==', '!=', '===', '!=='), $._expr)),
    cmp_expr: $ => prec.left(7, seq($._expr, choice('<', '>', '<=', '>=', '<=>'), $._expr)),

    // is, isnot, as operators
    type_check_expr: $ => prec.left(7, seq(
      $._expr,
      choice('is', 'isnot', 'as'),
      $.type_ref,
    )),

    range_expr: $ => prec.left(8, seq($._expr, choice('..', '..<'), $._expr)),
    add_expr: $ => prec.left(9, seq($._expr, choice('+', '-'), $._expr)),
    mul_expr: $ => prec.left(10, seq($._expr, choice('*', '/', '%'), $._expr)),

    unary_expr: $ => prec(11, seq(
      choice('!', '-', '+', '++', '--'),
      $._expr,
    )),

    // Cast expression: (Type)expr
    cast_expr: $ => prec(11, seq(
      '(',
      $.type_ref,
      ')',
      $._expr,
    )),

    // Term-chain (postfix) operators per Parser.fan termChainExpr:
    //   . / -> / ?. / ?-> / [...] / (...) / {...} (it-block) / |params| {...} (closure-as-arg)
    // Critical: `expr(args) { body }` is ONE expression (call with attached
    // it-block), not call followed by orphan block. Same for closure-only call
    // `expr |params| { body }` — common in `each` / `eachAttr`.
    postfix_expr: $ => prec.left(12, seq(
      $._expr,
      choice(
        seq($.call_args, optional($.it_block)), // call with optional trailing it-block
        seq('[', $._expr, ']'),
        seq('.', $.identifier),
        seq('?.', $.identifier),
        seq('->', $.identifier),
        seq('?->', $.identifier),
        $.it_block,
        $.closure,
        '++',
        '--',
      ),
    )),

    // It-block for DSL-style configuration. Same statement-list shape as
    // `block` — accepts `;` between statements (e.g. `{ args.add(e); flag = true }`).
    it_block: $ => seq(
      '{',
      repeat(';'),
      repeat(prec.left(seq($._stmt, repeat(';')))),
      '}',
    ),

    _primary: $ => choice(
      $.identifier,
      $.literal,
      $.this_expr,
      $.super_expr,
      $.it_expr,
      $.type_literal,
      $.slot_literal,
      $.list_lit,
      $.map_lit,
      $.closure,
      $.paren_expr,
      $.dsl_string,
    ),

    this_expr: $ => 'this',
    super_expr: $ => 'super',
    it_expr: $ => 'it',

    // Type literal: Str#, sys::Str#
    type_literal: $ => prec(1, seq(
      $.qualified_type_name,
      '#',
    )),

    // Slot literal: Int#plus, #echo (higher precedence because more specific)
    slot_literal: $ => prec(2, seq(
      optional($.qualified_type_name),
      '#',
      $.identifier,
    )),

    paren_expr: $ => seq('(', $._expr, ')'),

    call_args: $ => seq(
      '(',
      optional(seq(
        $._arg,
        repeat(seq(',', $._arg)),
      )),
      ')',
    ),

    _arg: $ => seq(
      optional(seq($.identifier, ':')),
      $._expr,
    ),

    // List literals. Fantom additionally allows `Type[,]` — a typed empty
    // list — which is conventional in test code (e.g. `XAttr[,]`).
    list_lit: $ => seq(
      optional($.simple_type),
      '[',
      optional(choice(
        ',',                        // Type[,]  empty typed list
        seq(
          $._expr,
          repeat(seq(',', $._expr)),
          optional(','),
        ),
      )),
      ']',
    ),

    // Map literals: [key:val, ...], [:], Str:Int[key:val, :]
    map_lit: $ => seq(
      optional(choice($.map_type, $.shorthand_map_type)),
      '[',
      optional(seq(
        $.map_pair,
        repeat(seq(',', $.map_pair)),
        optional(','),
      )),
      ':',
      ']',
    ),

    map_pair: $ => seq($._expr, ':', $._expr),

    // Closure literal. Fantom return-type annotation lives INSIDE the pipe
    // delimiters: `|TypeDef def -> Bool| { ... }`. The previous grammar placed
    // it after the closing `|`, which never matched real Fantom code.
    closure: $ => seq(
      '|',
      optional(seq($.closure_param, repeat(seq(',', $.closure_param)))),
      optional(seq('->', $.type_ref)),
      '|',
      choice($.block, $._expr),
    ),

    // Closure params can be:
    // - typed with name: Int a
    // - type only (it-block style): This, It
    // - name only (inferred): a
    closure_param: $ => choice(
      seq(field('type', $.type_ref), field('name', $.identifier)),
      field('type', $.type_ref),  // Type only (for |This| f syntax)
      field('name', $.identifier),
    ),

    // DSL string: Type<|...|>
    dsl_string: $ => seq(
      $.identifier,
      '<|',
      /[^|]*(\|[^>][^|]*)*/,
      '|>',
    ),

    // ============================================
    // Literals
    // ============================================
    literal: $ => choice(
      $.null_lit,
      $.bool_lit,
      $.int_lit,
      $.float_lit,
      $.decimal_lit,
      $.str_lit,
      $.triple_str_lit,
      $.char_lit,
      $.uri_lit,
      $.duration_lit,
    ),

    null_lit: $ => 'null',
    bool_lit: $ => choice('true', 'false'),

    // Integer: decimal, hex, binary
    int_lit: $ => token(choice(
      /0x[0-9a-fA-F_]+/,
      /0b[01_]+/,
      /[0-9][0-9_]*/,
    )),

    // Float: with f/F/d/D suffix optional
    float_lit: $ => token(
      /[0-9][0-9_]*\.[0-9][0-9_]*([eE][+-]?[0-9]+)?[fF]?/
    ),

    // Decimal: ends with d or D
    decimal_lit: $ => token(choice(
      /[0-9][0-9_]*[dD]/,
      /[0-9][0-9_]*\.[0-9][0-9_]*([eE][+-]?[0-9]+)?[dD]/,
    )),

    // Regular string with interpolation
    str_lit: $ => seq(
      '"',
      repeat(choice(
        /[^"\\$]+/,
        $.escape,
        $.interpolation,
      )),
      '"',
    ),

    // Triple-quoted string
    triple_str_lit: $ => seq(
      '"""',
      repeat(choice(
        /[^"\\$]+/,
        '"',
        '""',
        $.escape,
        $.interpolation,
      )),
      '"""',
    ),

    // Character literal (produces Int)
    char_lit: $ => seq(
      "'",
      choice(
        /[^'\\]/,
        $.escape,
      ),
      "'",
    ),

    // Escape sequences per Tokenizer.fan: \n \r \t \b \f \" \' \\ \$ \` \0
    // and \uXXXX hex unicode. Add backtick and `\u{...}` forms for completeness.
    escape: $ => token(choice(
      /\\[nrtbf"'\\$`0]/,
      /\\u[0-9a-fA-F]{4}/,
    )),

    interpolation: $ => seq(
      '$',
      choice(
        $.identifier,
        seq('{', $._expr, '}'),
      ),
    ),

    uri_lit: $ => /`[^`]*`/,
    // Duration literals: 100ms, 5sec, 1.5sec, 30min, 1day. Tokenizer.fan
    // accepts both integer and float magnitudes.
    duration_lit: $ => /[0-9][0-9_]*(\.[0-9][0-9_]*)?(ns|ms|sec|min|hr|day)/,

    // ============================================
    // Identifiers and Comments
    // ============================================
    identifier: $ => /[a-zA-Z_][a-zA-Z0-9_]*/,

    comment: $ => token(choice(
      seq('//', /.*/),
      seq('/*', /[^*]*\*+([^/*][^*]*\*+)*/, '/'),
    )),

    // Doc comments are `** ...` line-comments. The previous greedy `**` + `/.*/`
    // happily ate the `**` inside string literals (`"**"`, `"****"`), trashing
    // any source that contained those — notably FandocParser.fan. Require
    // whitespace OR end-of-line after the `**` so `**"` stays as two tokens.
    doc_comment: $ => token(seq('**', /[ \t][^\n]*|[\t ]*/)),
  },
});
