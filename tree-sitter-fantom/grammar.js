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

  // src/scanner.c: nested /* */ block comments (Tokenizer.fan skipCommentML).
  externals: $ => [
    // `comment` is also an internal `//` token below; the scanner produces
    // the nested `/* */` form under the same node name.
    $.comment,
    // `[` on the same line as the previous token, not followed by `]`
    // (TokenVal.isIndexOpenBracket = lbracket && !newline). Only this form
    // may start an index expression; a `[` that starts a new line begins a
    // new statement, e.g. `[Str:Obj?]? map := null`. Literals accept both.
    $._lbracket_same_line,
    // zero-width: an identifier starts on the same line (no newline in the gap).
    $._same_line,
    // zero-width: a `|...|` func-type signature followed by `{` starts here
    // (Parser.fan tryClosure: a closure needs its block, else it is not a
    // closure). Keeps `x := null` + newline + `|A,B|? f` from being a call.
    $._closure_ahead,
  ],

  conflicts: $ => [
    [$.local_def, $.expr_stmt],
    [$._stmt, $.if_stmt],
    [$.simple_type, $._primary],
    [$.type_literal, $.slot_literal],
    [$.return_stmt],
    [$._stmt, $.return_stmt],
    [$.func_type],
    [$.qualified_type_name, $.static_type_expr],
    [$.qualified_type_name, $._primary],
  ],

  rules: {
    // ============================================
    // Top Level
    // ============================================
    source_file: $ => seq(
      optional($.shebang),
      repeat($.using_statement),
      repeat($._type_definition),
    ),

    shebang: $ => token(/#![^\n]*/),

    // ============================================
    // Using Statements
    // ============================================
    using_statement: $ => seq(
      'using',
      optional(field('ffi', $.ffi)),
      field('path', $.dotted_name),
      optional(seq('as', field('alias', $.identifier))),
      optional(';'),
    ),

    _lbracket: $ => choice('[', $._lbracket_same_line),

    ffi: $ => seq($._lbracket, $.identifier, ']'),

    dotted_name: $ => seq(
      $.identifier,
      repeat(seq(choice('.', '::'), $.identifier)),
      repeat(seq('$', $.identifier)),
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
      optional(seq(':', $.type_list)),
      field('body', $.class_body),
    ),

    mixin_definition: $ => seq(
      repeat($.facet),
      repeat($.modifier),
      'mixin',
      field('name', $.identifier),
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
      repeat(choice($._slot, ';')),
      '}',
    ),

    enum_vals: $ => prec(2, seq(
      $.enum_val,
      repeat(seq(',', $.enum_val)),
    )),

    enum_val: $ => prec(2, seq(
      repeat($.facet),
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

    type_list: $ => seq(
      $.type_ref,
      repeat(seq(',', $.type_ref)),
    ),

    class_body: $ => seq(
      '{',
      repeat(choice($._slot, ';')),
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

    // `{ get { .. } private set { .. } }`, `{ private set }` (Parser.fan getOrSet)
    field_accessors: $ => seq(
      '{',
      repeat($.field_accessor),
      '}',
    ),

    field_accessor: $ => prec.right(seq(
      choice(
        seq(repeat($.modifier), choice('get', 'set'), optional($.block)),
        repeat1($.modifier),            // `{ private }` is legal
      ),
      optional(';'),
    )),


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
      repeat($.modifier),
      field('name', $.identifier),
      field('params', $.param_list),
      optional(seq(':', $.ctor_chain)),
      optional(field('body', $.block)),
    ),

    // `: super(args)`, `: this(args)`, `: super.named(args)` (Parser.fan ctorChain)
    ctor_chain: $ => seq(
      choice('this', 'super'),
      optional(seq('.', $.identifier)),
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
    // Types  (mirrors Parser.fan ctype(): base, then postfix ? / [] / :V)
    // ============================================
    type_ref: $ => choice(
      $.simple_type,
      $.func_type,
      $.map_type,            // [K:V]
      $.nullable_type,       // T?   (no whitespace before ?)
      $.list_type,           // T[]
      $.shorthand_map_type,  // K:V  (lowest binding, right assoc)
    ),

    simple_type: $ => $.qualified_type_name,

    qualified_type_name: $ => seq(
      $.identifier,
      repeat(seq('::', $.identifier)),
    ),

    nullable_type: $ => prec(20, seq($.type_ref, $._q_immediate)),

    // `?` with no whitespace before it (Parser.fan ctype: `!cur.whitespace`).
    // Shared with ternary_expr so `flag? a : b` lexes one way and GLR picks.
    _q_immediate: $ => token.immediate('?'),

    list_type: $ => prec(20, seq($.type_ref, '[]')),

    map_type: $ => seq(
      $._lbracket,
      field('key', $.type_ref),
      ':',
      field('val', $.type_ref),
      ']',
    ),

    shorthand_map_type: $ => prec.right(1, seq(
      field('key', $.type_ref),
      ':',
      field('val', $.type_ref),
    )),

    // |A a, B b -> R|   |->|   |Int a|   |Str? -> Void|   |Str?->Void|
    func_type: $ => seq(
      '|',
      optional(seq($.closure_param, repeat(seq(',', $.closure_param)))),
      optional(seq(choice('->', '?->'), optional($.type_ref))),
      '|',
    ),

    // Formal: `Type name`, `Type` (it-block style |This|), or `name` (inferred)
    closure_param: $ => choice(
      prec(2, seq(field('type', $.type_ref), field('name', $.identifier))),
      prec(1, field('name', $.identifier)),
      field('type', $.type_ref),
    ),

    // ============================================
    // Facets
    // ============================================
    facet: $ => seq(
      '@',
      $.identifier,
      optional(seq(
        '{',
        repeat(seq($.facet_pair, optional(choice(',', ';')))),
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

    // `<expr> ("," <expr>)* <eos>` — Parser.fan itAdd: a comma after an
    // expression statement is sugar for it.add(expr), in any block.
    expr_stmt: $ => prec.right(seq(
      $._expr,
      repeat(seq(',', $._expr)),
      optional(','),
    )),

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
      // Parser.fan switchStmt loops over case/default in any order; cases
      // may follow default (it only rejects a second default).
      repeat(choice($.case_block, $.default_block)),
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
    _try_body: $ => choice($.block, prec.right(seq($._stmt, optional(';')))),

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
      choice('?', $._q_immediate),
      choice($._expr, $.throw_expr),
      ':',
      choice($._expr, $.throw_expr),
    )),

    // `throw <expr>` in a ternary/elvis branch (Parser.fan ifExprBody)
    throw_expr: $ => prec.right(seq('throw', $._expr)),

    elvis_expr: $ => prec.right(3, seq(
      $._expr,
      '?:',
      choice($._expr, $.throw_expr),
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
        seq($._lbracket_same_line, $._expr, ']'),
        seq('.', choice($.identifier, $.storage_expr)),
        seq('?.', $.identifier),
        seq('->', $.identifier),
        seq('?->', $.identifier),
        $.it_block,
        seq($._closure_ahead, $.closure),
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
      $.static_type_expr,
      $.storage_expr,
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

    // `&count` raw field storage access; also `this.&count` via postfix
    storage_expr: $ => seq('&', $.identifier),

    // Pod-qualified type used as a term base (Grammar.md <staticCall>,
    // <ctorBlock>, <simple>). Requires `::` so a bare identifier stays
    // an identifier.
    static_type_expr: $ => seq($.identifier, repeat1(seq('::', $.identifier))),

    this_expr: $ => 'this',
    super_expr: $ => 'super',
    it_expr: $ => 'it',

    // Type literal: Str#, sys::Str#
    type_literal: $ => prec(1, seq(
      $.type_ref,
      '#',
    )),

    // Slot literal: Int#plus, #echo (higher precedence because more specific)
    slot_literal: $ => prec(2, seq(
      optional($.type_ref),
      '#',
      $._same_line,      // Parser.fan: slot literal only if id is on the same line
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

    _arg: $ => $._expr,

    // List literals. Fantom additionally allows `Type[,]` — a typed empty
    // list — which is conventional in test code (e.g. `XAttr[,]`).
    list_lit: $ => seq(
      optional($.type_ref),
      $._lbracket,
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
      optional($.type_ref),
      $._lbracket,
      choice(
        ':',                        // [:]  empty map
        seq(
          $.map_pair,
          repeat(seq(',', $.map_pair)),
          optional(','),
        ),
      ),
      ']',
    ),

    map_pair: $ => seq($._expr, ':', $._expr),

    // Closure literal. Fantom return-type annotation lives INSIDE the pipe
    // delimiters: `|TypeDef def -> Bool| { ... }`. The previous grammar placed
    // it after the closing `|`, which never matched real Fantom code.
    closure: $ => seq($.func_type, $.block),

    // DSL string: Type<|...|>
    dsl_string: $ => seq(
      $.type_ref,
      token(seq('<|', /([^|]|\|+[^|>])*/, /\|+>/)),
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

    // Number literals per Tokenizer.fan number(): digits with `_`,
    // optional fraction, optional exponent, then suffix f/F (float),
    // d/D (decimal), or a duration unit. A bare fraction/exponent is a float.
    int_lit: $ => token(choice(
      /0x[0-9a-fA-F_]+/,
      /0b[01_]+/,
      /[0-9][0-9_]*/,
    )),

    float_lit: $ => token(choice(
      /[0-9][0-9_]*(\.[0-9][0-9_]*)?([eE][+-]?[0-9][0-9_]*)?[fF]/,
      /[0-9][0-9_]*\.[0-9][0-9_]*([eE][+-]?[0-9][0-9_]*)?/,
      /[0-9][0-9_]*[eE][+-]?[0-9][0-9_]*/,
      /\.[0-9][0-9_]*([eE][+-]?[0-9][0-9_]*)?[fF]?/,
    )),

    decimal_lit: $ => token(choice(
      /[0-9][0-9_]*(\.[0-9][0-9_]*)?([eE][+-]?[0-9][0-9_]*)?[dD]/,
      /\.[0-9][0-9_]*([eE][+-]?[0-9][0-9_]*)?[dD]/,
    )),

    // Strings are single tokens. A seq-based rule let `extras` (comments,
    // whitespace) match inside the literal, so "//u:***@host" became a
    // line comment. Interpolation `$x` / `${expr}` is kept inside the token.
    str_lit: $ => token(/"([^"\\]|\\.|\$\{[^}]*\})*"/),

    triple_str_lit: $ => token(/"""(("|"")?([^"\\]|\\.))*("|"")?"""/),

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
      /\\u\{[0-9a-fA-F]+\}/,
    )),

    interpolation: $ => seq(
      '$',
      choice(
        $.identifier,
        seq('{', $._expr, '}'),
      ),
    ),

    uri_lit: $ => token(/`([^`\\]|\\.)*`/),
    // Duration literals: 100ms, 5sec, 1.5sec, 30min, 1day. Tokenizer.fan
    // accepts both integer and float magnitudes.
    duration_lit: $ => token(/[0-9][0-9_]*(\.[0-9][0-9_]*)?([eE][+-]?[0-9][0-9_]*)?(ns|ms|sec|min|hr|day)/),

    // ============================================
    // Identifiers and Comments
    // ============================================
    identifier: $ => /[a-zA-Z_][a-zA-Z0-9_]*/,

    comment: $ => token(seq('//', /.*/)),

    // Doc comments are `** ...` line-comments. The previous greedy `**` + `/.*/`
    // happily ate the `**` inside string literals (`"**"`, `"****"`), trashing
    // any source that contained those — notably FandocParser.fan. Require
    // whitespace OR end-of-line after the `**` so `**"` stays as two tokens.
    // `**` plus any further `*` (Tokenizer.fan docComment eats a run of stars).
    doc_comment: $ => token(/\*\*+[^\n]*/),
  },
});
