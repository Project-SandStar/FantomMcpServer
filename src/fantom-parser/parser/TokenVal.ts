import { Loc } from "../Loc";
import { Token, TokenType } from "./Token";

// TokenVal stores an instance of a Token at a specific location.
export class TokenVal extends Loc {
  kind: Token; // enum for Token type
  val: Object | null; // Str, Int, Float, Duration, or Str[]
  newline: boolean; // have we processed one or more newlines since the last token?
  whitespace: boolean; // was this token preceeded by whitespace?

  constructor(kind: Token, val: Object | null = null) {
    super(null);
    this.kind = kind;
    this.val = val;
  }

  //? override Int hash()
  //? {
  //?   return kind.hash
  //? }

  //? override Bool equals(Obj? obj)
  //? {
  //?   that := obj as TokenVal
  //?   if (that == null) return false
  //?   return (kind === that.kind) && (val == that.val)
  //? }

  //? override Str toStr()
  //? {
  //?   if (kind === Token.identifier) return val.toStr
  //?   return kind.symbol
  //? }

  //? **
  //? ** Get this token as Fantom source code.
  //? **
  //? Str toCode()
  //? {
  //?   switch (kind)
  //?   {
  //?     case Token.identifier:      return val
  //?     case Token.strLiteral:      return ((Str)val).toCode
  //?     case Token.intLiteral:      return ((Int)val).toCode
  //?     case Token.floatLiteral:    return ((Float)val).toCode
  //?     case Token.decimalLiteral:  return ((Decimal)val).toCode
  //?     case Token.durationLiteral: return ((Duration)val).toCode
  //?     case Token.uriLiteral:      return Uri.fromStr(val).toCode
  //?     case Token.dsl:             return "<|$val|>"
  //?   }
  //?   return kind.symbol
  //? }

  // **
  // ** Return if this token is a left opening paren,
  // ** but only if on the same line:
  // **
  // ** Ok:
  // **   call(...)
  // **
  // ** Not ok:
  // **   call
  // **     (...)
  // **
  isCallOpenParen(): boolean {
    return this.kind.type === TokenType.lparen && !this.newline;
  }

  // **
  // ** Return if this token is a left opening bracket,
  // ** but only if on the same line:
  // **
  // ** Ok:
  // **   expr[...]
  // **
  // ** Not ok:
  // **   expr
  // **     [...]
  // **
  isIndexOpenBracket(): boolean {
    return this.kind.type === TokenType.lbracket && !this.newline;
  }
}

// Extra information for DSL tokens.
export class TokenValDsl extends TokenVal {
  leadingTabs: number; // see DslExpr
  leadingSpaces: number; // see DslExpr

  constructor(kind: Token, src: string, tabs: number, spaces: number) {
    super(kind, src);
    this.leadingTabs = tabs;
    this.leadingSpaces = spaces;
  }
}
