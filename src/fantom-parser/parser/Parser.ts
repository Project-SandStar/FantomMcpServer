import { Block } from "../AST/Block";
import { DocDef } from "../AST/DefNode";
import { EnumDef } from "../AST/EnumDef";
import {
  BinaryExpr,
  CallExpr,
  ComplexLiteral,
  CondExpr,
  Expr,
  ExprId,
  ItExpr,
  LiteralExpr,
  LocaleLiteralExpr,
  RangeLiteralExpr,
  ShortcutExpr,
  SlotLiteralExpr,
  SuperExpr,
  TernaryExpr,
  ThisExpr,
  ThrowExpr,
  TypeCheckExpr,
  UnaryExpr,
  UnknownVarExpr,
} from "../AST/Expr";
import { FacetDef } from "../AST/FacetDef";
import { MethodDef } from "../AST/MethodDef";
import { Stmt } from "../AST/Stmt";
import { TypeDef } from "../AST/TypeDef";
import { Loc } from "../Loc";
import { Token, TokenType } from "./Token";
import { TokenVal } from "./TokenVal";

class Parser {
  //? private CompilationUnit unit    // compilation unit to generate
  private tokens: TokenVal[]; // tokens all read in
  private numTokens: number; // number of tokens
  private pos!: number; // offset into tokens for cur
  private cur!: TokenVal | null; // current token
  private curt!: Token | null; // current token type
  private peek!: TokenVal | null; // next token
  private peekt!: Token | null; // next token type
  //? private Bool inFieldInit        // are we currently in a field initializer
  private curType?: TypeDef; // current TypeDef scope
  private curSlot?: MethodDef; // current SlotDef scope
  //? private ClosureExpr? curClosure // current ClosureExpr if inside closure
  //? private Int? closureCount       // number of closures parsed inside curSlot
  //? private ClosureExpr[] closures  // list of all closures parsed

  // =======================================================
  // Construction
  // =======================================================

  /**
   * Construct the parser for the specified compilation unit (tokens).
   */
  constructor(tokens: TokenVal[], numTokens: number) {
    this.tokens = tokens;
    this.numTokens = numTokens;
    this.reset(0);
  }

  // =======================================================
  // Access
  // =======================================================

  /**
   * Top level parse a compilation unit
   */
  parse(): void {
    this.usings();
    while (this.curt?.type !== TokenType.eof) {
      this.typeDef();
    }
  }

  // =======================================================
  // Usings
  // =======================================================

  /**
   * Parse [using]*
   */
  private usings(): void {
    while (this.curt?.type == TokenType.usingKeyword) {
      this.skipUsing();
    }
  }

  private skipUsing(): void {
    this.consume(TokenType.usingKeyword);

    // <str> | <id> | "[" <id> "]" <id> ("." <id>)*
    if (this.curt?.type === TokenType.strLiteral) {
      this.consume();
    } else {
      if (this.curt?.type === TokenType.lbracket) {
        this.consume();
        this.consumeId();
        this.consume(TokenType.rbracket);
      }
      this.consumeId();
      while (this.curt?.type === TokenType.dot) {
        this.consume();
        this.consumeId();
      }
    }

    if (this.curt?.type === TokenType.doubleColon) {
      this.consume();
      this.consumeId();
      // @ts-ignore
      while (this.curt.type === TokenType.dollar) {
        this.consume();
        if (this.curt.type === TokenType.identifier) {
          this.consumeId();
        }
      }
      // @ts-ignore
      if (this.curt.type === TokenType.asKeyword) {
        this.consume();
        this.consumeId();
      }
    }
    this.endOfStmt();
  }

  // =======================================================
  // TypeDef
  // =======================================================

  /*
    TypeDef:
    <typeDef>      :=  <classDef> | <mixinDef> | <enumDef> | <facetDef>

    <classDef>     :=  <classHeader> <classBody>
    <classHeader>  :=  [<doc>] <facets> <typeFlags> "class" [<inheritance>]
    <classFlags>   :=  [<protection>] ["abstract"] ["final"]
    <classBody>    :=  "{" <slotDefs> "}"

    <enumDef>      :=  <enumHeader> <enumBody>
    <enumHeader>   :=  [<doc>] <facets> <protection> "enum" [<inheritance>]
    <enumBody>     :=  "{" <enumDefs> <slotDefs> "}"

    <facetDef      :=  <facetHeader> <enumBody>
    <facetHeader>  :=  [<doc>] <facets> [<protection>] "facet" "class" <id> [<inheritance>]
    <facetBody>    :=  "{" <slotDefs> "}"

    <mixinDef>     :=  <enumHeader> <enumBody>
    <mixinHeader>  :=  [<doc>] <facets> <protection> "mixin" [<inheritance>]
    <mixinBody>    :=  "{" <slotDefs> "}"

    <protection>   :=  "public" | "protected" | "private" | "internal"
    <inheritance>  :=  ":" <typeList>
   */
  typeDef(): void {
    //docs
    let doc = this.doc();

    if (this.curt?.type === TokenType.eof) {
      return;
    }

    // facets
    let facets = this.facets();

    //flags
    let flags = this.flags();

    // local working variables
    let loc = this.cur!;
    let isMixin = false;
    let isEnum = false;

    // mixin
    if (this.curt?.type === TokenType.mixinKeyword) {
      isMixin = true;
      this.consume();
    }

    // class
    else {
      // enum class
      if (
        this.curt?.type === TokenType.identifier &&
        this.cur!.val === "enum"
      ) {
        isEnum = true;
        this.consume();
      }
      // facet class
      if (
        this.curt?.type === TokenType.identifier &&
        this.cur!.val == "facet"
      ) {
        this.consume();
      }
      this.consume(TokenType.classKeyword);
    }

    let name = this.consumeId();
    const def = new TypeDef({
      loc,
      name,
      facets,
      flags,
      docDef: doc,
      isEnum,
      isMixin,
    });

    // inheritance
    if (this.curt?.type === TokenType.colon) {
      this.consume(); //consunme the colon

      def.addBase(this.consume());
      // @ts-ignore
      while (this.curt.type === TokenType.comma) {
        this.consume(); // consume the comma
        def.addBase(this.consume());
      }
    }

    // start class body
    this.consume(TokenType.lbrace);

    // assign current definition
    this.curType = def;

    // if enum, parse its enum defs
    if (isEnum) this.enumDefs(def);

    // slots
    // while (true) {
    //   doc = this.doc();
    //   if (this.curt?.type === TokenType.rbrace) {
    //     break;
    //   }
    //   let slot = this.slotDef(doc);

    //   if (slot) def.addSlot(slot);
    // }

    console.log(def);

    this.curType = undefined;

    // end of class body
    this.consume(TokenType.rbrace);
  }

  // =======================================================
  // Flags
  // =======================================================

  flags(): TokenVal[] | undefined {
    let flags = [];
    let done = false;

    while (!done) {
      switch (this.curt?.type) {
        case TokenType.abstractKeyword:
          flags.push(this.consume());
          break;
        case TokenType.constKeyword:
          flags.push(this.consume());
          break;
        case TokenType.finalKeyword:
          flags.push(this.consume());
          break;
        case TokenType.internalKeyword:
          flags.push(this.consume());
          break;
        case TokenType.nativeKeyword:
          flags.push(this.consume());
          break;
        case TokenType.newKeyword:
          flags.push(this.consume());
          break;
        case TokenType.onceKeyword:
          flags.push(this.consume());
          break;
        case TokenType.overrideKeyword:
          flags.push(this.consume());
          break;
        case TokenType.privateKeyword:
          flags.push(this.consume());
          break;
        case TokenType.protectedKeyword:
          flags.push(this.consume());
          break;
        case TokenType.publicKeyword:
          flags.push(this.consume());
          break;
        case TokenType.staticKeyword:
          flags.push(this.consume());
          break;
        case TokenType.virtualKeyword:
          flags.push(this.consume());
          break;
        default:
          done = true;
      }
    }
    return flags.length === 0 ? undefined : flags;
  }

  // =======================================================
  // Enum
  // =======================================================

  /**
   * Parse and consume a list of enum definations
   */
  enumDefs(def: TypeDef) {
    let ordinal = 0;
    def.addEnum(this.enumDef(ordinal));
    ordinal++;
    while (this.curt?.type === TokenType.comma) {
      this.consume();
      def.addEnum(this.enumDef(ordinal));
      ordinal++;
    }
    this.endOfStmt();
  }

  /**
   * Parse and consume one enum defination
   */
  enumDef(ordinal: number) {
    let doc = this.doc();
    let facets = this.facets();

    let enumDef = new EnumDef({
      loc: this.cur!,
      doc,
      facets,
      name: this.consumeId(),
      ordinal,
    });

    // optional ctor args
    if (this.curt?.type === TokenType.lparen) {
      this.consume(TokenType.lparen);
      // @ts-ignore
      if (this.curt.type !== TokenType.rparen) {
        while (true) {
          enumDef.addCtorArg(this.expr());
          // @ts-ignore
          if (this.curt.type === TokenType.rparen) break;
          this.consume(TokenType.comma);
        }
      }
      this.consume(TokenType.rparen);
    }

    return enumDef;
  }

  // =======================================================
  // Slots
  // =======================================================

  /**
   * Parse class slot definition: static init, methods, or fields
   */
  private slotDef(doc?: DocDef) {
    // check for static {} class initialization
    if (
      this.curt?.type === TokenType.staticKeyword &&
      this.peekt?.type === TokenType.lbrace
    ) {
      let loc = this.cur!;
      this.consume();
      let sInit = MethodDef.makeStaticInit({ loc });
      this.curSlot = sInit;
      //todo sInit.addStaticBlock(block);
      this.curSlot = undefined;
      return sInit;
    }

    // all members start with facets, flags
    let loc = this.cur;
    let facets = this.facets();
    let flags = this.flags();

    //todo: parse inferred type field slots

    //todo: parse constructor

    //todo: parse method or typed field slots
  }

  // =======================================================
  // FieldDef
  // =======================================================

  // =======================================================
  // MethodDef
  // =======================================================

  private methodDef(
    loc: Loc,
    name: string,
    doc?: DocDef,
    facets?: FacetDef[],
    flags?: TokenVal[]
  ) {
    let method = new MethodDef({ loc, name, docDef: doc, facets, flags });

    // enter scope
    this.curSlot = method;

    // parameters
    this.consume(TokenType.lparen);
    if (this.curt?.type !== TokenType.rparen) {
      //todo: parse params
    }
    this.consume(TokenType.rparen);

    //todo: parse ctorChain

    //todo: parse method body
    // body
    // method.addCodeBlock(this.block());

    // exit scope
    this.curSlot = undefined;

    return method;
  }

  //todo paramDef()

  //todo ctorChain()

  // =======================================================
  // Facets
  // =======================================================

  private facets(): FacetDef[] | undefined {
    if (this.curt?.type !== TokenType.at) {
      return;
    }
    let facets = [];
    while (this.curt.type === TokenType.at) {
      let loc = this.cur!;
      this.consume();

      let f = new FacetDef(loc);
      // @ts-ignore
      if (this.curt.type === TokenType.lbrace) {
        this.consume(TokenType.lbrace);
        while (this.curt.type === TokenType.identifier) {
          f.names.push(this.consumeId());
          this.consume(TokenType.assign);
          f.vals.push(this.expr());
          this.endOfStmt();
        }
        this.consume(TokenType.rbrace);
      }
      facets.push(f);
    }
    return facets;
  }

  // =======================================================
  // Block
  // =======================================================

  /**
   *
   */

  // =======================================================
  // Statements
  // =======================================================

  private stmt(): Stmt {
    // check for statement keywords
    switch (this.curt?.type) {
      case TokenType.breakKeyword:
        return breakStmt;
      case TokenType.continueKeyword:
        return continueStmt;
      case TokenType.forKeyword:
        return forStmt;
      case TokenType.ifKeyword:
        return ifStmt;
      case TokenType.returnKeyword:
        return returnStmt;
      case TokenType.switchKeyword:
        return switchStmt;
      case TokenType.throwKeyword:
        return throwStmt;
      case TokenType.tryKeyword:
        return tryStmt;
      case TokenType.whileKeyword:
        return whileStmt;
    }

    // at this point we either have an expr or local var declaration
    return this.exprOrLocalDefStmt(true);
  }

  private switchBlock(): Block {
    let block = new Block(this.cur!);
    while (
      this.curt?.type !== TokenType.caseKeyword &&
      this.curt?.type != TokenType.defaultKeyword &&
      this.curt?.type !== TokenType.rbrace
    ) {
      block.stmts.push(this.stmt());
    }
    return block;
  }

  // =======================================================
  // Expr
  // =======================================================

  /**
   * Expressions:
   *   [expr] = [assignExpr]
   */
  private expr(): Expr {
    return this.assignExpr();
  }

  /**
   * Assignment expression:
   *
   * [assignExpr]     :=  <ifExpr> [<assignOp> <assignExpr>]
   *
   * [assignOp]       :=  "=" | "*=" | "/=" | "%=" | "+=" | "-="
   */
  private assignExpr(expr: Expr | null = null): Expr {
    // this is tree if built to the right (others to the left)
    if (expr == null) {
      expr = this.ifExpr();
    }
    if (this.curt!.isAssign) {
      if (this.curt?.type === TokenType.assign)
        return new BinaryExpr(expr, this.consume().kind, this.assignExpr());
      else
        return ShortcutExpr.makeBinary(
          expr,
          this.consume().kind,
          this.assignExpr()
        );
    }
    return expr;
  }

  /**
   * Ternary/Elvis expressions:
   *   <ifExpr>       :=  <ternaryExpr> | <elvisExpr>
   *   <ternaryExpr>  :=  <condOrExpr> ["?" <ifExprBody> ":" <ifExprBody>]
   *   <elvisExpr>    :=  <condOrExpr> "?:" <ifExprBody>
   */
  ifExpr(): Expr {
    let expr = this.condOrExpr();
    if (this.curt?.type === TokenType.question) {
      let condition = expr;
      this.consume(TokenType.question);
      let trueExpr = this.ifExprBody();
      // nice error checking for Foo? x :=
      if (
        // @ts-ignore
        this.curt.type === TokenType.defAssign &&
        expr.id === ExprId.unknownVar &&
        trueExpr.id === ExprId.unknownVar
      )
        throw new Error(
          `Unknown type ${expr} for local declaration ${expr.loc}`
        );
      this.consume(TokenType.colon);
      let falseExpr = this.ifExprBody();
      expr = new TernaryExpr(condition, trueExpr, falseExpr);
    } else if (this.curt?.type === TokenType.elvis) {
      let lhs = expr;
      this.consume();
      let rhs = this.ifExprBody();
      expr = new BinaryExpr(lhs, new Token(TokenType.elvis), rhs);
    }
    return expr;
  }
  /**
   * If expression body (ternary/elvis):
   *   <ifExprBody>   :=  <condOrExpr> | <ifExprThrow>
   *   <ifExprThrow>  :=  "throw" <expr>
   */
  private ifExprBody(): Expr {
    if (this.curt?.type === TokenType.throwKeyword) {
      let loc = this.cur!;
      this.consume(TokenType.throwKeyword);
      return new ThrowExpr(loc, this.expr());
    } else {
      return this.condOrExpr();
    }
  }

  /**
   * Conditional or expression:
   *   <condOrExpr>  :=  <condAndExpr>  ("||" <condAndExpr>)*
   */
  private condOrExpr(): Expr {
    let expr = this.condAndExpr();
    if (this.curt?.type === TokenType.doublePipe) {
      let cond = new CondExpr(expr, this.cur!.kind);
      while (this.curt.type === TokenType.doublePipe) {
        this.consume();
        cond.operands.push(this.condAndExpr());
      }
      expr = cond;
    }
    return expr;
  }

  /**
   * Conditional and expression:
   *   <condAndExpr>  :=  <equalityExpr> ("&&" <equalityExpr>)*
   */
  private condAndExpr(): Expr {
    let expr = this.equalityExpr();
    if (this.curt?.type === TokenType.doubleAmp) {
      let cond = new CondExpr(expr, this.cur!.kind);
      while (this.curt.type === TokenType.doubleAmp) {
        this.consume();
        cond.operands.push(this.equalityExpr());
      }
      expr = cond;
    }
    return expr;
  }

  /**
   * Equality expression:
   *   <equalityExpr>  :=  <relationalExpr> [("==" | "!=" | "===" | "!==") <relationalExpr>]
   */
  private equalityExpr(): Expr {
    let expr = this.relationalExpr();
    if (
      this.curt?.type === TokenType.eq ||
      this.curt?.type === TokenType.notEq ||
      this.curt?.type === TokenType.same ||
      this.curt?.type === TokenType.notSame
    ) {
      let lhs = expr;
      let tok = this.consume().kind;
      let rhs = this.relationalExpr();

      // optimize for null literal
      if (lhs.id === ExprId.nullLiteral || rhs.id === ExprId.nullLiteral) {
        let id =
          tok.type === TokenType.eq || tok.type === TokenType.same
            ? ExprId.cmpNull
            : ExprId.cmpNotNull;
        let operand = lhs.id === ExprId.nullLiteral ? rhs : lhs;
        expr = new UnaryExpr(lhs.loc, id, tok, operand);
      } else {
        if (tok.type === TokenType.same || tok.type === TokenType.notSame)
          expr = new BinaryExpr(lhs, tok, rhs);
        else expr = ShortcutExpr.makeBinary(lhs, tok, rhs);
      }
    }
    return expr;
  }

  /**
   * Relational expression:
   *   <relationalExpr> :=  <typeCheckExpr> | <compareExpr>
   *   <typeCheckExpr>  :=  <rangeExpr> [("is" | "as" | "isnot") <type>]
   *   <compareExpr>    :=  <rangeExpr> [("<" | "<=" | ">" | ">=" | "<=>") <rangeExpr>]
   */
  private relationalExpr(): Expr {
    let expr = this.rangeExpr();
    if (
      this.curt?.type === TokenType.isKeyword ||
      this.curt?.type === TokenType.isnotKeyword ||
      this.curt?.type === TokenType.asKeyword ||
      this.curt?.type === TokenType.lt ||
      this.curt?.type === TokenType.ltEq ||
      this.curt?.type === TokenType.gt ||
      this.curt?.type === TokenType.gtEq ||
      this.curt?.type === TokenType.cmp
    ) {
      switch (this.curt.type) {
        case TokenType.isKeyword:
          this.consume();
          expr = new TypeCheckExpr(expr.loc, ExprId.isExpr, expr);
        case TokenType.isnotKeyword:
          this.consume();
          expr = new TypeCheckExpr(expr.loc, ExprId.isnotExpr, expr);
        case TokenType.asKeyword:
          this.consume();
          expr = new TypeCheckExpr(expr.loc, ExprId.asExpr, expr);
        default:
          expr = ShortcutExpr.makeBinary(
            expr,
            this.consume().kind,
            this.rangeExpr()
          );
      }
    }
    return expr;
  }

  /**
   * Range expression:
   *   <rangeExpr>  :=  <bitOrExpr> ((".." | "...") <bitOrExpr>)*
   */
  private rangeExpr(): Expr {
    let expr = this.addExpr();
    if (
      this.curt?.type === TokenType.dotDot ||
      this.curt?.type === TokenType.dotDotLt
    ) {
      let start = expr;
      // @ts-ignore
      let exclusive = this.consume().kind === TokenType.dotDotLt;
      let end = this.addExpr();
      return new RangeLiteralExpr(expr.loc, start, end, exclusive);
    }
    return expr;
  }

  /**
   * Additive expression:
   *   <addExpr>  :=  <multExpr> (("+" | "-") <multExpr>)*
   */
  private addExpr(): Expr {
    let expr = this.multExpr();
    while (
      this.curt?.type === TokenType.plus ||
      this.curt?.type === TokenType.minus
    )
      expr = ShortcutExpr.makeBinary(
        expr,
        this.consume().kind,
        this.multExpr()
      );
    return expr;
  }

  /**
   * Multiplicative expression:
   *   <multExpr>  :=  <parenExpr> (("*" | "/" | "%") <parenExpr>)*
   */
  private multExpr(): Expr {
    let expr = this.parenExpr();
    while (
      this.curt?.type === TokenType.star ||
      this.curt?.type === TokenType.slash ||
      this.curt?.type === TokenType.percent
    )
      expr = ShortcutExpr.makeBinary(
        expr,
        this.consume().kind,
        this.parenExpr()
      );
    return expr;
  }

  /**
   * Paren grouped expression:
   */
  private parenExpr(): Expr {
    if (
      this.curt?.type !== TokenType.lparen &&
      // @ts-ignore
      this.curt?.type !== TokenType.lparenSynthetic
    ) {
      return this.unaryExpr();
    }

    // consume opening paren (or synthetic paren)
    let loc = this.cur!;
    this.consume();

    // In Fantom just like C# and Java, a paren could mean
    // either a cast or a parenthesized expression
    let mark = this.pos;
    // @ts-ignore
    if (this.curt.type === TokenType.rparen) {
      this.consume();
      // if (castType == null) throw err("Expecting cast '(type)'")
      return new TypeCheckExpr(loc, ExprId.coerce, this.parenExpr());
    }
    this.reset(mark);

    // this is just a normal parenthesized expression
    let expr = this.expr();
    this.consume(TokenType.rparen);
    while (true) {
      let chained = this.termChainExpr(expr);
      if (chained == null) {
        break;
      }
      expr = chained;
    }
    return expr;
  }

  private unaryExpr(): Expr {
    let loc = this.cur!;
    let tok = this.cur!;
    let tokt = this.curt!;

    if (tokt?.type === TokenType.bang) {
      this.consume();
      return new UnaryExpr(loc, tokt.toExprId(), tokt, this.parenExpr());
    }

    if (tokt.type === TokenType.plus) {
      this.consume();
      return this.parenExpr(); // optimize +expr to just expr
    }

    if (tokt.type === TokenType.minus) {
      this.consume();
      return ShortcutExpr.makeUnary(loc, tokt, this.parenExpr());
    }

    if (tokt.isIncrementOrDecrement()) {
      this.consume();
      return ShortcutExpr.makeUnary(loc, tokt, this.parenExpr());
    }

    let expr = this.termExpr();

    // postfix ++/-- must be on the same line
    tokt = this.curt!;
    tok = this.cur!;
    if (tokt.isIncrementOrDecrement() && !tok.newline) {
      this.consume();
      let shortcut = ShortcutExpr.makeUnary(loc, tokt, expr);
      shortcut.isPostfixLeave = true;
      return shortcut;
    }

    return expr;
  }

  // =======================================================
  // Term Expr
  // =======================================================

  /**
   * A term is a base terminal such as a variable, call, or literal,
   * optionally followed by a chain of accessor expressions - such
   * as "x.y[z](a, b)".
   *
   *   <termExpr>  :=  <termBase> <termChain>*
   */
  private termExpr(target: Expr | null = null): Expr {
    if (target == null) target = this.termBaseExpr();
    while (true) {
      let chained = this.termChainExpr(target);
      if (chained == null) break;
      target = chained;
    }
    return target;
  }

  /**
   * Atomic base of a termExpr
   *
   *   <termBase>    :=  <literal> | <idExpr> | <closure> | <dsl>
   *   <literal>     :=  "null" | "this" | "super" | <bool> | <int> |
   *                     <float> | <str> | <duration> | <list> | <map> | <uri> |
   *                     <typeLiteral> | <slotLiteral>
   *   <typeLiteral> :=  <type> "#"
   *   <slotLiteral> :=  [<type>] "#" <id>
   */
  private termBaseExpr(): Expr {
    let loc = this.cur!;

    // ctype := tryType
    // if (ctype != null) return typeBaseExpr(loc, ctype)

    switch (this.curt?.type) {
      case TokenType.amp:
        return this.idExpr(null, false, false);
      case TokenType.identifier:
        return this.idExpr(null, false, false);
      case TokenType.intLiteral:
        return new LiteralExpr(loc, ExprId.intLiteral, this.consume().val);
      case TokenType.floatLiteral:
        return new LiteralExpr(loc, ExprId.floatLiteral, this.consume().val);
      case TokenType.decimalLiteral:
        return new LiteralExpr(loc, ExprId.decimalLiteral, this.consume().val);
      case TokenType.strLiteral:
        return new LiteralExpr(loc, ExprId.strLiteral, this.consume().val);
      case TokenType.durationLiteral:
        return new LiteralExpr(loc, ExprId.durationLiteral, this.consume().val);
      case TokenType.uriLiteral:
        return new LiteralExpr(loc, ExprId.uriLiteral, this.consume().val);
      case TokenType.localeLiteral:
        return new LocaleLiteralExpr(loc, this.consume().val as string);
      //todo case TokenType.lbracket:
      //todo   return collectionLiteralExpr(loc, null);
      case TokenType.falseKeyword:
        this.consume();
        return LiteralExpr.makeFalse(loc);
      case TokenType.nullKeyword:
        this.consume();
        return LiteralExpr.makeNull(loc);
      case TokenType.superKeyword:
        this.consume();
        // @ts-ignore
        if (this.curt.type !== TokenType.dot) {
          Error("Expected '.' dot after 'super' keyword");
        }
        return new SuperExpr(loc);
      case TokenType.thisKeyword:
        this.consume();
        return new ThisExpr(loc);
      case TokenType.itKeyword:
        this.consume();
        return new ItExpr(loc);
      case TokenType.trueKeyword:
        this.consume();
        return LiteralExpr.makeTrue(loc);
      case TokenType.pound:
        this.consume();
        return new SlotLiteralExpr(loc, this.consumeId());
    }

    if (this.curt?.type == TokenType.pipe)
      throw new Error("Invalid closure expression (check types)");
    else throw new Error("Expected expression, not '" + this.cur + "'");
  }

  /**
   * Handle a term expression which begins with a type literal.
   */
  //? private  typeBaseExpr(loc:Loc):Expr
  //? {
  //?   // type or slot literal
  //?   if (this.curt?.type === TokenType.pound)
  //?   {
  //?     this.consume()
  //?     if (this.curt.type === TokenType.identifier && !this.cur!.newline)
  //?       return new SlotLiteralExpr(loc, this.consumeId())
  //?     else
  //?       return new LiteralExpr(loc, ExprId.typeLiteral, null)
  //?   }
  //?
  //?   // dot is named super or static call chain
  //?   if (this.curt?.type == TokenType.dot)
  //?   {
  //?     this.consume()
  //?     if (this.curt.type === TokenType.superKeyword)
  //?     {
  //?       this.consume()
  //?       if (this.curt.type !== TokenType.dot) {Error("Expected '.' dot after 'super' keyword")}
  //?       return new SuperExpr(loc)
  //?     }
  //?     else
  //?     {
  //?       return this.idExpr(new StaticTargetExpr(loc), false, false)
  //?     }
  //?   }
  //?
  //?   // dsl
  //?   if (this.curt?.type == TokenType.dsl)
  //?   {
  //?     let srcLoc = new Loc(this.cur!.file, this.cur!.line, this.cur!.col!+2)
  //?     let dslVal = this.cur as TokenValDsl
  //?      const expr = new DslExpr(loc,  srcLoc, this.consume().val as string)
  //?       expr.leadingTabs = dslVal.leadingTabs
  //?       expr.leadingSpaces = dslVal.leadingSpaces
  //?       return expr;
  //?   }
  //?
  //?   // list/map literal with explicit type
  //?   if (this.curt?.type === TokenType.lbracket)
  //?   {
  //?     return collectionLiteralExpr(loc)
  //?   }
  //?
  //?   // closure
  //?   if (this.curt?.type == TokenType.lbrace)
  //?   {
  //?     return closure(loc, (FuncType)ctype)
  //?   }
  //?
  //?   // simple literal type(arg)
  //?   if (this.curt?.type == TokenType.lparen)
  //?   {
  //?     let construction = new CallExpr(loc, new StaticTargetExpr(loc), "<ctor>", ExprId.construction)
  //?     this.callArgs(construction)
  //?     return construction
  //?   }
  //?
  //?   // constructor it-block {...}
  //?   if (this.curt?.type == TokenType.lbrace)
  //?   {
  //?     // if not inside a field/method we have complex literal for facet
  //?     if (curSlot == null) return this.complexLiteral(loc)
  //?
  //?     // shortcut for make with optional it-block
  //?     let ctor = new CallExpr(loc, new StaticTargetExpr(loc), "make")
  //?     let itBlock = tryItBlock
  //?     if (itBlock != null) ctor.args.push(itBlock)
  //?     return ctor
  //?   }
  //?
  //?   throw new Error(`Unexpected type literal ${loc}`)
  //? }

  /**
   * A chain expression is a piece of a term expression that may
   * be chained together such as "call.var[x]".  If the specified
   * target expression contains a chained access, then return the new
   * expression, otherwise return null.
   *
   *   <termChain>      :=  <compiledCall> | <dynamicCall> | <indexExpr>
   *   <compiledCall>   :=  "." <idExpr>
   *   <dynamicCall>    :=  "->" <idExpr>
   */
  private termChainExpr(target: Expr): Expr | null {
    let loc = this.cur;

    // handle various call operators: . -> ?. ?->
    switch (this.curt?.type) {
      // if ".id" field access or ".id" call
      case TokenType.dot:
        this.consume();
        return this.idExpr(target, false, false);

      // if "->id" dynamic call
      case TokenType.arrow:
        this.consume();
        return this.idExpr(target, true, false);

      // if "?.id" safe call
      case TokenType.safeDot:
        this.consume();
        return this.idExpr(target, false, true);

      // if "?->id" safe dynamic call
      case TokenType.safeArrow:
        this.consume();
        return this.idExpr(target, true, true);
    }

    // if target[...]
    if (this.cur!.isIndexOpenBracket()) return this.indexExpr(target);

    // if target(...)
    if (this.cur!.isCallOpenParen()) {
      return this.callOp(target);
    }

    // if target {...}
    if (this.curt?.type === TokenType.lbrace) {
      //todo let itBlock = tryItBlock();
      //todo if (itBlock != null) return itBlock.toWith(target);
    }

    // otherwise the expression should be finished
    return null;
  }

  // =======================================================
  // Term Expr Utils
  // =======================================================

  /**
   * Identifier expression:
   *   <idExpr>  :=  <local> | <field> | <call>
   *   <local>   :=  <id>
   *   <field>   :=  ["*"] <id>
   */
  private idExpr(
    target: Expr | null,
    dynamicCall: boolean,
    safeCall: boolean
  ): Expr {
    let loc = this.cur!;

    if (this.curt?.type == TokenType.amp) {
      this.consume();
      let vari = new UnknownVarExpr(
        loc,
        target,
        this.consumeId(),
        ExprId.storage
      );
      vari.isSafe = safeCall;
      return vari;
    }

    if (this.peek!.isCallOpenParen()) {
      let call = this.callExpr(target);
      call.isDynamic = dynamicCall;
      call.isSafe = safeCall;
      return call;
    }

    let name = this.consumeId();

    // if we have a closure then this is a call with one arg of a closure
    //todo let closure = tryClosure
    //todo if (closure != null)
    //todo {
    //todo   call := CallExpr(loc)
    //todo   call.target    = target
    //todo   call.name      = name
    //todo   call.isDynamic = dynamicCall
    //todo   call.isSafe    = safeCall
    //todo   call.noParens  = true
    //todo   call.args.add(closure)
    //todo   return call
    //todo }

    // if dynamic call then we know this is a call not a field
    if (dynamicCall) {
      let call = new CallExpr(loc);
      call.target = target;
      call.name = name;
      call.isDynamic = true;
      call.isSafe = safeCall;
      call.noParens = true;
      return call;
    }

    // at this point we are parsing a single identifier, but
    // if it looks like it was expected to be a type we can
    // provide a more meaningful error
    if (this.curt?.type === TokenType.pound) {
      throw new Error(`Unknown type ${name} for type literal ${loc}`);
    }

    const expr = new UnknownVarExpr(loc, target, name);
    expr.isSafe = safeCall;
    return expr;
  }

  /**
   * Call expression:
   *  <call>  :=  <id> ["(" <args> ")"] [<closure>]
   */
  private callExpr(target: Expr | null): CallExpr {
    let call = new CallExpr(this.cur!);
    call.target = target;
    call.name = this.consumeId();
    this.callArgs(call);
    return call;
  }

  /**
   * Parse args with known parens:
   *   <args>  := [<expr> ("," <expr>)*] [<closure>]
   */
  private callArgs(call: CallExpr, closureOk: boolean = true): void {
    this.consume(TokenType.lparen);
    if (this.curt?.type != TokenType.rparen) {
      while (true) {
        call.args.push(this.expr());
        // @ts-ignore
        if (this.curt?.type === TokenType.rparen) {
          break;
        }
        this.consume(TokenType.comma);
      }
    }
    this.consume(TokenType.rparen);

    if (closureOk) {
      //TODO let closure = tryClosure
      //todo if (closure != null) call.args.push(closure)
    }
  }

  /**
   * Call operator:
   *   <callOp>  := "(" <args> ")" [<closure>]
   */
  private callOp(target: Expr): Expr {
    let loc = this.cur!;
    let call = new CallExpr(loc);
    call.isCallOp = true;
    call.target = target;
    this.callArgs(call);
    call.name = "call";
    return call;
  }

  /**
   * Index expressiothis!.curn():
   *   <this.indexExpr>  := "[" <expr> "]"
   */
  private indexExpr(target: Expr): Expr {
    let loc = this.cur!;
    this.consume(TokenType.lbracket);

    // nice error for BadType[,]
    if (this.curt?.type === TokenType.comma && target.id === ExprId.unknownVar)
      throw new Error(`Unknown type ${target} for list literal ${target.loc}`);

    // otherwise this must be a standard single key index
    let expr = this.expr();
    this.consume(TokenType.rbracket);
    return ShortcutExpr.makeGet(loc, target, expr);
  }

  // =======================================================
  // Collection "Literals"
  // =======================================================

  // =======================================================
  // Closures
  // =======================================================

  /**
   * This is used to parse an it-block outside of the scope of a
   * field or method definition. It is used to parse complex literals
   * declared in a facet without mucking up the closure code path.
   */
  private complexLiteral(loc: Loc): Expr {
    let complex = new ComplexLiteral(loc);
    this.consume(TokenType.lbrace);
    while (this.curt?.type !== TokenType.rbrace) {
      complex.names.push(this.consumeId());
      this.consume(TokenType.assign);
      complex.vals.push(this.expr());
      this.endOfStmt();
    }
    this.consume(TokenType.rbrace);
    return complex;
  }

  // =======================================================
  // Types
  // =======================================================

  type(): string {
    let type = "";
    // Types can begin with:
    //   - id
    //   - [k:v]
    //   - |a, b -> r|
    if (this.curt?.type === TokenType.identifier) {
      // let;
    }

    return "";
  }

  // =======================================================
  // Misc
  // =======================================================

  /**
   * parse fandoc or return null
   */
  private doc(): DocDef | undefined {
    let doc: DocDef | undefined;

    while (this.curt?.type === TokenType.docComment) {
      let loc = this.cur!;
      let lines = this.consume(TokenType.docComment).val as string[];
      doc = new DocDef(loc, lines);
    }
    return doc;
  }

  // =======================================================
  // Errors
  // =======================================================

  // =======================================================
  // Tokens
  // =======================================================

  /**
   * Verify current is an identifier, consume it, and return it.
   */
  private consumeId(): string {
    if (this.curt?.type !== TokenType.identifier) {
      {
        throw new Error(`Expected identifier, not ${this.cur}`);
      }
    }
    return this.consume().val as string;
  }

  /**
   * Check that the current token matches the specified
   * type, but do not consume it
   */
  private verify(kind: TokenType): void {
    if (this.curt?.type !== kind) {
      throw new Error(`Expected ${kind}, not ${this.cur?.kind.symbol}`);
    }
  }

  /**
   * Consume the current token and return the consumed token.
   * if kind is non-null then verify first
   */
  private consume(kind: TokenType | null = null): TokenVal {
    let result = this.cur!;

    if (kind != null) {
      this.verify(kind);
    }

    let next: TokenVal | null;
    this.pos++;
    if (this.pos + 1 < this.numTokens) {
      next = this.tokens[this.pos + 1];
    } else {
      next = this.tokens[this.numTokens - 1];
    }

    this.cur = this.peek;
    this.peek = next;
    this.curt = this.cur!.kind;
    this.peekt = this.peek.kind;

    return result;
  }

  /**
   * makes sure the statement ends and consumes a semicolon if it exists
   */
  private endOfStmt(
    errMsg: string = `Expected end of statement: semicolon, newline, or end of block; not ${this.cur}`
  ): boolean {
    if (this.cur!.newline) {
      return true;
    }
    if (this.curt?.type === TokenType.semicolon) {
      this.consume();
      return true;
    }
    if (this.curt?.type === TokenType.rbrace) {
      return true;
    }
    if (this.curt?.type === TokenType.eof) {
      return true;
    }
    if (errMsg == null) {
      return false;
    }
    throw new Error(errMsg);
  }

  private reset(pos: number): void {
    this.pos = pos;
    this.cur = this.tokens[pos];
    if (pos + 1 < this.numTokens) {
      this.peek = this.tokens[pos + 1];
    } else this.peek = this.tokens[pos];
    this.curt = this.cur.kind;
    this.peekt = this.peek.kind;
  }

  // =======================================================
  // Parser Flags
  // =======================================================
}

export { Parser };
