import { ExprId, ShortcutOp } from "../AST/Expr";

export enum TokenType {
  /*
   ** identifiers
   */
  identifier = "identifier",
  strLiteral = "Str literal",
  intLiteral = "Int literal",
  floatLiteral = "Float literal",
  decimalLiteral = "Decimal literal",
  durationLiteral = "Duration literal",
  uriLiteral = "Uri literal",
  dsl = "DSL",
  localeLiteral = "Locale literal",
  /*
   ** operators
   */
  dot = ".",
  semicolon = ";",
  comma = ",",
  colon = ":",
  doubleColon = "::",
  plus = "+",
  minus = "-",
  star = "*",
  slash = "/",
  percent = "%",
  pound = "#",
  increment = "++",
  decrement = "--",
  bang = "!",
  question = "?",
  tilde = "~",
  pipe = "|",
  amp = "&",
  caret = "^",
  at = "@",
  doublePipe = "||",
  doubleAmp = "&&",
  same = "===",
  notSame = "!==",
  eq = "==",
  notEq = "!=",
  cmp = "<=>",
  lt = "<",
  ltEq = "<=",
  gt = ">",
  gtEq = ">=",
  lbrace = "{",
  rbrace = "}",
  lparen = "(",
  rparen = ")",
  lbracket = "[",
  rbracket = "]",
  dotDot = "..",
  dotDotLt = "..<",
  defAssign = ":=",
  assign = "=",
  assignPlus = "+=",
  assignMinus = "-=",
  assignStar = "*=",
  assignSlash = "/=",
  assignPercent = "%=",
  arrow = "->",
  elvis = "?:",
  safeDot = "?.",
  safeArrow = "?->",
  docComment = "**",
  dollar = "$",
  lparenSynthetic = "(", // synthetic () grouping of interpolated string exprs
  /*
   ** keywords
   */
  abstractKeyword = "abstractKeyword",
  asKeyword = "asKeyword",
  assertKeyword = "assertKeyword",
  breakKeyword = "breakKeyword",
  caseKeyword = "caseKeyword",
  catchKeyword = "catchKeyword",
  classKeyword = "classKeyword",
  constKeyword = "constKeyword",
  continueKeyword = "continueKeyword",
  defaultKeyword = "defaultKeyword",
  doKeyword = "doKeyword",
  elseKeyword = "elseKeyword",
  falseKeyword = "falseKeyword",
  finalKeyword = "finalKeyword",
  finallyKeyword = "finallyKeyword",
  forKeyword = "forKeyword",
  foreachKeyword = "foreachKeyword",
  ifKeyword = "ifKeyword",
  internalKeyword = "internalKeyword",
  isKeyword = "isKeyword",
  isnotKeyword = "isnotKeyword",
  itKeyword = "itKeyword",
  mixinKeyword = "mixinKeyword",
  nativeKeyword = "nativeKeyword",
  newKeyword = "newKeyword",
  nullKeyword = "nullKeyword",
  onceKeyword = "onceKeyword",
  overrideKeyword = "overrideKeyword",
  privateKeyword = "privateKeyword",
  protectedKeyword = "protectedKeyword",
  publicKeyword = "publicKeyword",
  readonlyKeyword = "readonlyKeyword",
  returnKeyword = "returnKeyword",
  staticKeyword = "staticKeyword",
  superKeyword = "superKeyword",
  switchKeyword = "switchKeyword",
  thisKeyword = "thisKeyword",
  throwKeyword = "throwKeyword",
  trueKeyword = "trueKeyword",
  tryKeyword = "tryKeyword",
  usingKeyword = "usingKeyword",
  virtualKeyword = "virtualKeyword",
  volatileKeyword = "volatileKeyword",
  voidKeyword = "voidKeyword",
  whileKeyword = "whileKeyword",
  /*
   ** end of file
   */
  eof = "eof",
}

export class Token {
  type: TokenType;
  symbol: string;
  isKeyword?: boolean;
  isAssign?: boolean;

  constructor(type: TokenType, symbol: string | null = null) {
    this.type = type;
    if (symbol === null) {
      if (!type.endsWith("Keyword")) {
        throw new Error(type);
      }
      this.symbol = type.slice(0, -7);
      this.isKeyword = true;
      this.isAssign = false;
    } else {
      this.symbol = symbol;
      this.isKeyword = false;
      this.isAssign = type.startsWith("assign");
    }
  }

  // ? toExprId

  // ? toShortcutOp

  // Is one of: public, protected, internal, private
  isProtectionKeyword(): boolean {
    return (
      this.type === TokenType.publicKeyword ||
      this.type === TokenType.protectedKeyword ||
      this.type === TokenType.privateKeyword ||
      this.type === TokenType.internalKeyword
    );
  }

  // Return if -- or ++
  isIncrementOrDecrement(): boolean {
    return (
      this.type === TokenType.increment || this.type === TokenType.decrement
    );
  }

  // Get a map of the keywords
  static readonly keywords: Map<string, Token> = (() => {
    const map = new Map<string, Token>();
    Object.values(TokenType)
      .filter(el => el.endsWith("Keyword"))
      .map(el => new Token(el))
      .forEach(t => {
        map.set(t.symbol, t);
      });
    return map;
  })();

  toExprId(): ExprId {
    switch (this.type) {
      // unary
      case TokenType.bang:
        return ExprId.boolNot;

      // binary
      case TokenType.assign:
        return ExprId.assign;
      case TokenType.doubleAmp:
        return ExprId.boolAnd;
      case TokenType.doublePipe:
        return ExprId.boolOr;
      case TokenType.same:
        return ExprId.same;
      case TokenType.notSame:
        return ExprId.notSame;
      case TokenType.elvis:
        return ExprId.elvis;

      // default
      default:
        throw new Error(this.toStr());
    }
  }

  toShortcutOp(degree: number): ShortcutOp {
    switch (this.type) {
      case TokenType.plus:
        return ShortcutOp.plus(); // a + b
      case TokenType.minus:
        return degree == 1 ? ShortcutOp.negate() : ShortcutOp.minus(); // -a; a - b
      case TokenType.star:
        return ShortcutOp.mult(); // a * b
      case TokenType.slash:
        return ShortcutOp.div(); // a / b
      case TokenType.percent:
        return ShortcutOp.mod(); // a % b
      case TokenType.increment:
        return ShortcutOp.increment(); // ++a, a++
      case TokenType.decrement:
        return ShortcutOp.decrement(); // --a, a--
      case TokenType.eq:
        return ShortcutOp.eq(); // a == b
      case TokenType.notEq:
        return ShortcutOp.eq(); // a != b
      case TokenType.cmp:
        return ShortcutOp.cmp(); // a <=> b
      case TokenType.gt:
        return ShortcutOp.cmp(); // a > b
      case TokenType.gtEq:
        return ShortcutOp.cmp(); // a >= b
      case TokenType.lt:
        return ShortcutOp.cmp(); // a < b
      case TokenType.ltEq:
        return ShortcutOp.cmp(); // a <= b
      case TokenType.assignPlus:
        return ShortcutOp.plus(); // a += b
      case TokenType.assignMinus:
        return ShortcutOp.minus(); // a -= b
      case TokenType.assignStar:
        return ShortcutOp.mult(); // a *= b
      case TokenType.assignSlash:
        return ShortcutOp.div(); // a /= b
      case TokenType.assignPercent:
        return ShortcutOp.mod(); // a %= b
      default:
        throw new Error(this.toStr());
    }
  }

  toStr(): string {
    return this.symbol;
  }
}
