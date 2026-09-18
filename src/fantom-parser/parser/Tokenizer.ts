import { NumberUtils, StringUtils } from "../../utils";
import { Loc } from "../Loc";
import { Token, TokenType } from "./Token";
import { TokenVal, TokenValDsl } from "./TokenVal";

export class Tokenizer {
  private buf: string; // buffer
  private pos: number; // index into buf for cur
  private isDoc: boolean; // return documentation comments or if false ignore them
  private filename: string | null; // source file name
  private line: number = 1; // pos line number
  private col: number = 1; // pos column number
  private curLine: number; // line number of current token
  private cur: number; // current char
  private peek: number; // next char
  private lastLine: number; // line number of last token returned from next()
  private posOfLine: number; // index into buf for start of current line
  private tokens: TokenVal[]; // token accumulator
  private inStrLiteral: boolean; // return if inside a string literal token
  private whitespace: boolean; // was there whitespace before current token

  constructor(loc: Loc, buf: string, isDoc: boolean) {
    this.buf = buf;
    this.filename = loc.file;
    this.isDoc = isDoc;
    this.tokens = [];
    this.inStrLiteral = false;
    this.posOfLine = 0;
    this.whitespace = false;

    // initialize cur and peek
    this.cur = this.peek = " ".codePointAt(0) ?? 0;
    if (this.buf.length > 0) {
      this.cur = buf.codePointAt(0) ?? 0;
    }
    if (this.buf.length > 1) {
      this.peek = buf.codePointAt(0) ?? 0;
    }
    this.pos = 0;

    // if first line starts with #, then treat it like an end of
    // line, so that Unix guys can specify the executable to run
    if (this.cur === "#".codePointAt(0)) {
      while (true) {
        if (this.cur === "\n".codePointAt(0)) {
          this.consume();
          break;
        }
        if (this.cur === 0) break;
        this.consume();
      }
    }
  }

  // Tokenize the entire input into a list of tokens.
  tokenize(): TokenVal[] {
    while (true) {
      let tok = this.next();
      tok && this.tokens.push(tok);
      if (tok?.kind.type === TokenType.eof) break;
    }
    return this.tokens;
  }

  // Return the next token in the buffer.
  next(): TokenVal | null {
    while (true) {
      // save current line
      this.curLine = this.line;
      let col = this.col;

      // find next token
      let tok: TokenVal | null = this.find();
      if (tok === null) {
        continue;
      }

      // fill in token's location
      tok.file = this.filename;
      tok.line = this.curLine;
      tok.col = col;
      tok.newline = this.lastLine < this.line;
      tok.whitespace = this.whitespace;

      // save last line, clear whitespace flag
      this.lastLine = this.line;
      this.whitespace = false;

      return tok;
    }
    return null; // TODO - shouldn't need this
  }

  // Find the next token or return null.
  find(): TokenVal | null {
    // skip whitespace
    if (NumberUtils.isCodePointSpace(this.cur)) {
      this.consume();
      this.whitespace = true;
      return null;
    }

    // alpha means keyword or identifier
    if (Tokenizer.isIdentifierStart(this.cur)) {
      return this.word();
    }

    // number or .number (note that + and - are handled as unary operator)
    if (NumberUtils.isCodePointDigit(this.cur)) {
      return this.number();
    }
    if (
      this.cur === ".".codePointAt(0) &&
      NumberUtils.isCodePointDigit(this.peek)
    ) {
      return this.number();
    }

    // str literal
    if (
      this.cur === '"'.codePointAt(0) &&
      this.peek === '"'.codePointAt(0) &&
      this.peekPeek() === '"'
    ) {
      return this.quoted(new Quoted(QuotedType.triple, true));
    }
    if (this.cur === '"'.codePointAt(0)) {
      return this.quoted(new Quoted(QuotedType.normal, true));
    }
    if (this.cur === "`".codePointAt(0)) {
      return this.quoted(new Quoted(QuotedType.uri, false));
    }
    if (this.cur === "'".codePointAt(0)) {
      return this.ch();
    }

    // comments
    if (this.cur === "*".codePointAt(0) && this.peek === "*".codePointAt(0)) {
      return this.docComment();
    }
    if (this.cur === "/".codePointAt(0) && this.peek === "/".codePointAt(0)) {
      return this.skipCommentSL();
    }
    if (this.cur === "/".codePointAt(0) && this.peek === "*".codePointAt(0)) {
      return this.skipCommentML();
    }

    // DSL
    if (this.cur === "<".codePointAt(0) && this.peek === "|".codePointAt(0)) {
      return this.dsl();
    }

    // symbols
    return this.symbol();
  }

  // Parse a word token: alpha (alpha|number)*
  // Words are either keywords or identifiers
  word(): TokenVal {
    // store starting position of word
    let start = this.pos;

    // find end of word to compute length
    while (
      NumberUtils.isCodePointAlphaNumeric(this.cur) ||
      this.cur === "_".codePointAt(0)
    ) {
      this.consume();
    }

    // create Str (gc note this string might now reference buf)
    let word = this.buf.slice(start, this.pos);

    // check keywords
    let keyword = Token.keywords.get(word);
    if (keyword) {
      return new TokenVal(keyword);
    }

    // otherwise this is a normal identifier

    return new TokenVal(
      new Token(TokenType.identifier, TokenType.identifier),
      word
    );
  }

  static isIdentifierStart(c?: number): boolean {
    if (!c) return false;
    return NumberUtils.isCodePointAlpha(c) || String.fromCodePoint(c) === "_";
  }

  // Parse a number literal token: int, float, decimal, or duration.
  number(): TokenVal {
    // check for hex value
    if (this.cur === "0".codePointAt(0)) {
      if (this.peek === "x".codePointAt(0)) {
        return this.hexInt();
      }
      if (this.peek === "b".codePointAt(0)) {
        return this.binaryInt();
      }
    }

    // find end of literal
    let start = this.pos;
    let dot = false;
    let exp = false;

    // whole part
    while (
      NumberUtils.isCodePointDigit(this.cur) ||
      this.cur === "_".codePointAt(0)
    ) {
      this.consume();
    }

    // fraction part
    if (
      this.cur === ".".codePointAt(0) &&
      NumberUtils.isCodePointDigit(this.peek)
    ) {
      dot = true;
      this.consume();
      while (
        NumberUtils.isCodePointDigit(this.cur) ||
        this.cur === "_".codePointAt(0)
      ) {
        this.consume();
      }
    }

    // exponent
    if (this.cur === "e".codePointAt(0) || this.cur === "E".codePointAt(0)) {
      this.consume();
      exp = true;
      if (this.cur === "-".codePointAt(0) || this.cur === "+".codePointAt(0)) {
        this.consume();
      }
      if (!NumberUtils.isCodePointDigit(this.cur)) {
        throw new Error("Expected exponent digits");
      }
      while (
        NumberUtils.isCodePointDigit(this.cur) ||
        this.cur === "_".codePointAt(0)
      ) {
        this.consume();
      }
    }

    // string value of literal
    let str = this.buf.slice(start, this.pos).replace("_", "");

    // check for suffixes
    let floatSuffix = false;
    let decimalSuffix = false;
    let dur: number | null = null;
    if (
      StringUtils.isLower(String.fromCodePoint(this.cur)) &&
      StringUtils.isLower(String.fromCodePoint(this.peek))
    ) {
      if (this.cur === "n".codePointAt(0) && this.peek === "s".codePointAt(0)) {
        this.consume();
        this.consume();
        dur = 1;
      }
      if (this.cur === "m".codePointAt(0) && this.peek === "s".codePointAt(0)) {
        this.consume();
        this.consume();
        dur = 1000000;
      }
      if (this.cur === "s".codePointAt(0) && this.peek === "e".codePointAt(0)) {
        this.consume();
        this.consume();
        if (this.cur !== "c".codePointAt(0)) {
          throw new Error("Expected 'sec' in Duration literal");
        }
        this.consume();
        dur = 1_000_000_000;
      }
      if (this.cur === "m".codePointAt(0) && this.peek === "i".codePointAt(0)) {
        this.consume();
        this.consume();
        if (this.cur !== "n".codePointAt(0)) {
          throw new Error("Expected 'min' in Duration literal");
        }
        this.consume();
        dur = 60_000_000_000;
      }
      if (this.cur === "h".codePointAt(0) && this.peek === "r".codePointAt(0)) {
        this.consume();
        this.consume();
        dur = 3_600_000_000_000;
      }
      if (this.cur === "d".codePointAt(0) && this.peek === "a".codePointAt(0)) {
        this.consume();
        this.consume();
        if (this.cur !== "y".codePointAt(0)) {
          throw new Error("Expected 'day' in Duration literal");
        }
        this.consume();
        dur = 86_400_000_000_000;
      }
    } else if (
      this.cur === "f".codePointAt(0) ||
      this.cur === "F".codePointAt(0)
    ) {
      this.consume();
      floatSuffix = true;
    } else if (
      this.cur === "d".codePointAt(0) ||
      this.cur === "D".codePointAt(0)
    ) {
      this.consume();
      decimalSuffix = true;
    }

    try {
      // float literal
      if (floatSuffix) {
        let num = Number(str);
        return new TokenVal(
          new Token(TokenType.floatLiteral, TokenType.floatLiteral),
          num
        );
      }

      // decimal literal
      if (decimalSuffix || dot || exp) {
        let num = Number(str);
        if (dur !== null) {
          return new TokenVal(
            new Token(TokenType.durationLiteral, TokenType.durationLiteral)
            //TODO Duration((num * dur.toDecimal).toInt)
          );
        } else {
          if (!decimalSuffix) {
            throw new Error("Float/Decimal literal must have f/d suffix");
          }
          return new TokenVal(
            new Token(TokenType.decimalLiteral, TokenType.decimalLiteral),
            num
          );
        }
      }

      // int literal
      let num = Number(str);
      if (dur !== null)
        return new TokenVal(
          new Token(TokenType.durationLiteral, TokenType.durationLiteral)
          //TODO Duration(num * dur)
        );
      else
        return new TokenVal(
          new Token(TokenType.intLiteral, TokenType.intLiteral),
          num
        );
    } catch (err) {
      throw new Error(`Invalid numeric literal '${str}'`);
    }
  }

  // Process hex int/long literal starting with 0x
  hexInt(): TokenVal {
    this.consume(); // 0
    this.consume(); // x

    // read first hex
    let val = parseInt(String.fromCharCode(this.cur), 16);
    if (!val) {
      throw new Error("Expecting hex number");
    }
    this.consume();
    let nibCount = 1;
    while (true) {
      let nib = parseInt(String.fromCharCode(this.cur), 16);
      if (nib === null) {
        if (this.cur === "_".codePointAt(0)) {
          this.consume();
          continue;
        }
        break;
      }
      nibCount++;
      if (nibCount > 16) {
        throw new Error("Hex literal too big");
      }
      val = (val << 4) + nib;
      this.consume();
    }

    return new TokenVal(
      new Token(TokenType.intLiteral, TokenType.intLiteral),
      val
    );
  }

  // Process binary int/long literal starting with 0b
  binaryInt(): TokenVal {
    this.consume(); // 0
    this.consume(); // b

    // read first digit
    let val = parseInt(String.fromCharCode(this.cur), 2);
    if (val === null) {
      throw new Error("Expecting binary digit");
    }
    this.consume();
    let bitCount = 1;
    while (true) {
      let bit = parseInt(String.fromCharCode(this.cur), 2);
      if (bit === null) {
        if (this.cur === "_".codePointAt(0)) {
          this.consume();
          continue;
        }
        break;
      }
      bitCount++;
      if (bitCount > 64) {
        throw new Error("Binary literal too big");
      }
      val = (val << 1) + bit;
      this.consume();
    }

    return new TokenVal(
      new Token(TokenType.intLiteral, TokenType.intLiteral),
      val
    );
  }

  // Parse a quoted literal token: normal, triple, or uri
  // Opening quote must already be consumed.
  quoted(q: Quoted): TokenVal | null {
    this.inStrLiteral = true;
    try {
      // opening quote
      let line = this.line;
      let col = this.col;
      this.consume();
      if (q.isTriple()) {
        this.consume();
        this.consume();
      }

      // init starting position
      let openLine = this.posOfLine;
      let openPos = this.pos;
      let multiLineOk = true;
      let s: string = "";
      let interpolated = false;

      // loop until we find end of string
      while (true) {
        if (this.cur === 0) {
          throw Error(`Unexpected end of ${q}`);
        }

        if (this.endOfQuoted(q)) {
          break;
        }

        if (this.cur === "\n".codePointAt(0)) {
          if (!q.multiLine) {
            throw Error(`Unexpected end of ${q}`);
          }
          s += String.fromCodePoint(this.cur);

          this.consume();
          if (multiLineOk) {
            multiLineOk = this.skipStrWs(openLine, openPos);
          }
          continue;
        }

        if (this.cur === "$".codePointAt(0)) {
          // if we have detected an interpolated string, then
          // insert opening paren to treat whole string atomically
          if (!interpolated) {
            interpolated = true;
            this.tokens.push(
              this.makeVirtualToken(
                line,
                col,
                new Token(TokenType.lparenSynthetic, TokenType.lparenSynthetic),
                null
              )
            );
          }

          // process interpolated string, it returns null
          // if at end of string literal
          if (!this.interpolation(line, col, s, q)) {
            line = this.line;
            col = this.col - 1; // before quote
            this.tokens.push(
              this.makeVirtualToken(
                line,
                col,
                new Token(TokenType.rparen, TokenType.rparen),
                null
              )
            );
            if (q.isUri()) {
              this.tokens.push(
                this.makeVirtualToken(
                  line,
                  col,
                  new Token(TokenType.dot, TokenType.dot)
                )
              );
              this.tokens.push(
                this.makeVirtualToken(
                  line,
                  col,
                  new Token(TokenType.identifier, TokenType.identifier),
                  "toUri"
                )
              );
            }
            return null;
          }
          line = this.line;
          col = this.col;

          s = "";
        } else if (this.cur === "\\".codePointAt(0)) {
          if (q.isUri()) {
            switch (this.peek) {
              case ":".codePointAt(0):
              case "/".codePointAt(0):
              case "?".codePointAt(0):
              case "#".codePointAt(0):
              case "[".codePointAt(0):
              case "]".codePointAt(0):
              case "@".codePointAt(0):
              case "\\".codePointAt(0):
              case "&".codePointAt(0):
              case "=".codePointAt(0):
              case ";".codePointAt(0):
                s += `${String.fromCodePoint(this.cur)}${String.fromCodePoint(
                  this.peek
                )}`;
                this.consume();
                this.consume();
                break;
              default:
                s += String.fromCharCode(this.escape());
            }
          } else {
            s += String.fromCharCode(this.escape());
          }
        } else {
          s += String.fromCodePoint(this.cur);
          this.consume();
        }
      }

      // if interpolated then we add rparen to treat whole atomically,
      // and if URI, then add call to Uri
      if (interpolated) {
        this.tokens.push(
          this.makeVirtualToken(
            line,
            col,
            new Token(TokenType.strLiteral, TokenType.strLiteral),
            s
          )
        );
        line = this.line;
        col = this.col - 1; // before quote
        this.tokens.push(
          this.makeVirtualToken(
            line,
            col,
            new Token(TokenType.rparen, TokenType.rparen),
            null
          )
        );
        if (q.isUri()) {
          this.tokens.push(
            this.makeVirtualToken(
              line,
              col,
              new Token(TokenType.dot, TokenType.dot),
              null
            )
          );
          this.tokens.push(
            this.makeVirtualToken(
              line,
              col,
              new Token(TokenType.identifier, TokenType.identifier),
              "toUri"
            )
          );
        }
        return null;
      } else {
        if (q.isUri()) {
          return new TokenVal(
            new Token(TokenType.uriLiteral, TokenType.uriLiteral),
            s
          );
        } else {
          return new TokenVal(
            new Token(TokenType.strLiteral, TokenType.strLiteral),
            s
          );
        }
      }
    } finally {
      this.inStrLiteral = false;
    }
  }

  skipStrWs(openLine: number, openPos: number): boolean {
    for (let i = openLine; i < openPos; ++i) {
      let a = this.buf[i];
      if (
        (a === "\t" && this.cur !== "\t".codePointAt(0)) ||
        (a !== "\t" && this.cur !== " ".codePointAt(0))
      ) {
        if (this.cur === "\n".charCodeAt(0)) {
          return true;
        }
        let numTabs = 0;
        let numSpaces = 0;
        for (let j = openLine; j < openPos; ++j) {
          if (this.buf[j] === "\t") {
            ++numTabs;
          } else {
            ++numSpaces;
          }
        }
        if (numTabs === 0) {
          new Error(
            "Leading space in multi-line Str must be $numSpaces spaces"
          );
        } else
          new Error(
            "Leading space in multi-line Str must be $numTabs tabs and $numSpaces spaces"
          );
        return false;
      }
      this.consume();
    }
    return true;
  }

  //
  // When we hit a $ inside a string it indicates an embedded
  // expression.  We make this look like a stream of tokens
  // such that:
  //   "a ${b} c" -> "a " + b + " c"
  //   "a $<b> c" -> "a " + LocaleExpr("b") + " c"
  // Return true if more in the string literal.
  //
  interpolation(line: number, col: number, s: string, q: Quoted): boolean {
    this.consume(); // $
    this.tokens.push(
      this.makeVirtualToken(
        line,
        col,
        new Token(TokenType.strLiteral, TokenType.strLiteral),
        s
      )
    );
    line = this.line;
    col = this.col;
    this.tokens.push(
      this.makeVirtualToken(
        line,
        col,
        new Token(TokenType.plus, TokenType.plus)
      )
    );

    // if { we allow an expression b/w {...}
    if (this.cur === "{".codePointAt(0)) {
      line = this.line;
      col = this.col;
      this.tokens.push(
        this.makeVirtualToken(
          line,
          col,
          new Token(TokenType.lparenSynthetic, TokenType.lparenSynthetic)
        )
      );
      this.consume();
      while (true) {
        if (this.endOfQuoted(q) || this.cur === 0) {
          throw new Error("Unexpected end of $q, missing }");
        }
        let tok = this.next();
        if (tok?.kind.type === TokenType.strLiteral) {
          throw new Error(
            `Cannot nest Str literal within interpolation ${tok}`
          );
        }
        if (tok?.kind.type === TokenType.uriLiteral) {
          throw new Error(
            `Cannot nest Uri literal within interpolation ${tok}`
          );
        }
        if (tok?.kind.type === TokenType.rbrace) {
          break;
        }
        tok && this.tokens.push(tok);
      }
      line = this.line;
      col = this.col;
      this.tokens.push(
        this.makeVirtualToken(
          line,
          col,
          new Token(TokenType.rparen, TokenType.rparen)
        )
      );
    }

    // if < this is a localized literal <xxxx>
    else if (this.cur === "<".codePointAt(0)) {
      line = this.line;
      col = this.col;
      this.tokens.push(
        this.makeVirtualToken(
          line,
          col,
          new Token(TokenType.lparenSynthetic, TokenType.lparenSynthetic)
        )
      );
      this.consume();
      let buf = "";
      while (true) {
        if (this.endOfQuoted(q) || this.cur === 0) {
          throw new Error("Unexpected end of $q, missing >");
        }
        if (this.cur === "\n".codePointAt(0)) {
          throw new Error("Unexpected newline, missing >");
        }
        if (this.cur === ">".codePointAt(0)) break;
        buf += String(this.cur);
        this.consume();
      }
      this.consume();

      let tok = new TokenVal(
        new Token(TokenType.localeLiteral, TokenType.localeLiteral),
        buf
      );
      tok.file = this.filename;
      tok.line = line;
      tok.col = col;
      this.tokens.push(tok);

      line = this.line;
      col = this.col;
      this.tokens.push(
        this.makeVirtualToken(
          line,
          col,
          new Token(TokenType.rparen, TokenType.rparen)
        )
      );
    }

    // else also allow a single identifier with
    // dotted accessors x, x.y, x.y.z
    else {
      let tok = this.next();
      if (
        tok?.kind.type !== TokenType.identifier &&
        tok?.kind.type !== TokenType.thisKeyword &&
        tok?.kind.type !== TokenType.superKeyword &&
        tok?.kind.type !== TokenType.itKeyword
      )
        throw new Error("Expected identifier after $");
      this.tokens.push(tok);
      while (true) {
        if (this.cur !== ".".codePointAt(0)) break;
        if (!Tokenizer.isIdentifierStart(this.peek)) {
          throw new Error("Expected identifier after dot");
        }
        let nextToken = this.next();
        nextToken && this.tokens.push(nextToken); // dot
        tok = this.next();
        tok && this.tokens.push(tok);
      }
    }

    // if at end of string, all done
    if (this.endOfQuoted(q)) return false;

    // add plus and return true to keep chugging
    line = this.line;
    col = this.col;
    this.tokens.push(
      this.makeVirtualToken(
        line,
        col,
        new Token(TokenType.plus, TokenType.plus)
      )
    );
    return true;
  }

  // If at end of quoted literal consume the
  // ending token(s) and return true.
  endOfQuoted(q: Quoted): boolean {
    switch (q.type) {
      case QuotedType.normal: {
        if (this.cur !== '"'.codePointAt(0)) {
          return false;
        }
        this.consume();
        return true;
      }

      case QuotedType.triple: {
        if (
          this.cur !== '"'.codePointAt(0) ||
          this.peek !== '"'.codePointAt(0) ||
          this.peekPeek() !== '"'
        ) {
          return false;
        }
        this.consume();
        this.consume();
        this.consume();
        return true;
      }

      case QuotedType.uri: {
        if (this.cur !== "`".codePointAt(0)) {
          return false;
        }
        this.consume();
        return true;
      }

      default: {
        throw Error(q.toStr());
      }
    }
  }

  // Create a virtual token for string interpolation.
  makeVirtualToken(
    line: number,
    col: number,
    kind: Token,
    value: Object | null = null
  ): TokenVal {
    let tok = new TokenVal(kind, value);
    tok.line = line;
    tok.col = col;
    return tok;
  }

  // Parse a char literal token.
  ch(): TokenVal {
    // consume opening quote
    this.consume();

    // if \ then process as escape
    let c = -1;
    if (this.cur === "\\".codePointAt(0)) {
      c = this.escape();
    } else {
      c = this.cur;
      this.consume();
    }

    // expecting ' quote
    if (this.cur !== "'".codePointAt(0)) {
      throw new Error("Expecting ' close of char literal");
    }
    this.consume();

    return new TokenVal(
      new Token(TokenType.intLiteral, TokenType.intLiteral),
      String.fromCodePoint(c)
    );
  }

  escape(): number {
    // consume slash
    if (this.cur !== "\\".codePointAt(0)) {
      throw new Error("Internal error");
    }
    this.consume();

    // check basics
    switch (this.cur) {
      case "b".codePointAt(0):
        this.consume();
        return "\b".codePointAt(0)!;
      case "f".codePointAt(0):
        this.consume();
        return "\f".codePointAt(0)!;
      case "n".codePointAt(0):
        this.consume();
        return "\n".codePointAt(0)!;
      case "r".codePointAt(0):
        this.consume();
        return "\r".codePointAt(0)!;
      case "t".codePointAt(0):
        this.consume();
        return "\t".codePointAt(0)!;
      case '"'.codePointAt(0):
        this.consume();
        return '"'.codePointAt(0)!;
      case "$".codePointAt(0):
        this.consume();
        return "$".codePointAt(0)!;
      case "'".codePointAt(0):
        this.consume();
        return "'".codePointAt(0)!;
      case "`".codePointAt(0):
        this.consume();
        return "`".codePointAt(0)!;
      case "\\".codePointAt(0):
        this.consume();
        return "\\".codePointAt(0)!;
    }

    // check for \uxxxx or \u{xxx}
    if (this.cur === "u".codePointAt(0)) {
      this.consume();
      if (this.cur === "{".codePointAt(0)) {
        this.consume();
        let ch = 0;
        let numDigits = 0;
        while (this.cur !== "}".codePointAt(0)) {
          let i = parseInt(String.fromCharCode(this.cur), 16);
          numDigits++;
          if (i === null) {
            throw new Error("Invalid hex value for \\u{x}");
          }
          ch = (ch << 4) | i;
          this.consume();
        }
        if (numDigits === 0 || numDigits > 6)
          throw new Error("Invalid number of hex digits for \\u{x}");
        this.consume();
        return ch;
      } else {
        let n3 = parseInt(String.fromCharCode(this.cur), 16);
        this.consume();
        let n2 = parseInt(String.fromCharCode(this.cur), 16);
        this.consume();
        let n1 = parseInt(String.fromCharCode(this.cur), 16);
        this.consume();
        let n0 = parseInt(String.fromCharCode(this.cur), 16);
        this.consume();
        if (n3 === null || n2 === null || n1 === null || n0 === null) {
          throw new Error("Invalid hex value for \\uxxxx");
        }
        return (n3 << 12) | (n2 << 8) | (n1 << 4) | n0;
      }
    }

    throw new Error("Invalid escape sequence");
  }

  // Parse a domain specific language <| ... |>
  dsl(): TokenVal {
    this.consume(); // <
    this.consume(); // |

    // compute leading tabs/spaces
    let leadingTabs = 0;
    let leadingSpaces = 0;
    for (let i = this.posOfLine; i < this.pos; ++i)
      if (this.buf[i] === "\t") {
        leadingTabs++;
      } else {
        leadingSpaces++;
      }

    // loop until we find end of DSL
    let s = "";
    while (true) {
      if (this.cur === "|".codePointAt(0) && this.peek === ">".codePointAt(0))
        break;
      if (this.cur === 0) {
        throw new Error("Unexpected end of DSL");
      }
      s += this.cur;
      this.consume();
    }

    this.consume(); // |
    this.consume(); // >

    return new TokenValDsl(
      new Token(TokenType.dsl, TokenType.dsl),
      s,
      leadingTabs,
      leadingSpaces
    );
  }

  /***************************************************
   * Comments
   ***************************************************/

  // Skip a single line // comment
  skipCommentSL(): TokenVal | null {
    this.consume(); // first slash
    this.consume(); // next slash
    while (true) {
      if (this.cur === "\n".codePointAt(0)) {
        this.consume();
        break;
      }
      if (this.cur === 0) break;
      this.consume();
    }
    return null;
  }

  // Skip a multi line \/* comment. Note unlike C/Java
  // slash/star comments can be nested.
  skipCommentML(): TokenVal | null {
    this.consume(); // first slash
    this.consume(); // next slash
    let depth = 1;
    while (true) {
      if (this.cur === "*".codePointAt(0) && this.peek === "/".codePointAt(0)) {
        this.consume();
        this.consume();
        depth--;
        if (depth <= 0) {
          break;
        }
      }
      if (this.cur === "/".codePointAt(0) && this.peek === "*".codePointAt(0)) {
        this.consume();
        this.consume();
        depth++;
        continue;
      }
      if (this.cur === 0) {
        break;
      }
      this.consume();
    }
    return null;
  }

  // Parse a Javadoc style comment into a documentation comment token.
  docComment(): TokenVal | null {
    // if doc is off, then just skip the line and be done
    if (!this.isDoc) {
      this.skipCommentSL();
      return null;
    }

    while (this.cur === "*".codePointAt(0)) {
      this.consume();
    }
    if (this.cur === " ".codePointAt(0)) {
      this.consume();
    }

    // parse comment
    let lines: String[] = [];
    let s = "";
    while (this.cur !== null) {
      // add to buffer and advance
      let c = this.cur;
      this.consume();

      // if not at newline, then loop
      if (c !== "\n".codePointAt(0)) {
        s += String.fromCodePoint(c);
        continue;
      }

      // add line and reset buffer
      // if leading empty lines then skip them and update this.curLine to
      // ensure location starts at first non-empty line
      let line = s;
      if (lines.length !== 0 || line.trim().length !== 0) {
        lines.push(line);
      } else {
        this.curLine++;
      }
      s = "";

      // we at a newline, check for leading whitespace(0+)/star(2+)/whitespace(1)
      while (
        this.cur === " ".codePointAt(0) ||
        this.cur === "\t".codePointAt(0)
      ) {
        this.consume();
      }
      if (this.cur != "*".codePointAt(0) || this.peek != "*".codePointAt(0))
        break;
      while (this.cur === "*".codePointAt(0)) {
        this.consume();
      }
      if (this.cur === " ".codePointAt(0) || this.cur === "\t".codePointAt(0)) {
        this.consume();
      }
    }
    lines.push(s);

    // strip trailing empty lines
    while (lines.length !== 0)
      if (lines.at(-1)?.trim().length === 0) {
        lines.pop();
      } else {
        break;
      }

    return new TokenVal(
      new Token(TokenType.docComment, TokenType.docComment),
      lines
    );
  }

  // Parse a symbol token (typically into an operator).
  symbol(): TokenVal {
    let c = this.cur;
    this.consume();
    switch (c) {
      case "\r".codePointAt(0):
        throw new Error("Carriage return \\r not allowed in source");
      case "!".codePointAt(0):
        if (this.cur === "=".charCodeAt(0)) {
          this.consume();
          if (this.cur === "=".codePointAt(0)) {
            this.consume();
            return new TokenVal(
              new Token(TokenType.notSame, TokenType.notSame)
            );
          }
          return new TokenVal(new Token(TokenType.notEq, TokenType.notEq));
        }
        return new TokenVal(new Token(TokenType.bang, TokenType.bang));
      case "#".codePointAt(0):
        return new TokenVal(new Token(TokenType.pound, TokenType.pound));
      case "%".codePointAt(0):
        if (this.cur === "=".codePointAt(0)) {
          this.consume();
          return new TokenVal(
            new Token(TokenType.assignPercent, TokenType.assignPercent)
          );
        }
        return new TokenVal(new Token(TokenType.percent, TokenType.percent));
      case "&".codePointAt(0):
        if (this.cur === "&".codePointAt(0)) {
          this.consume();
          return new TokenVal(
            new Token(TokenType.doubleAmp, TokenType.doubleAmp)
          );
        }
        return new TokenVal(new Token(TokenType.amp, TokenType.amp));
      case "(".codePointAt(0):
        return new TokenVal(new Token(TokenType.lparen, TokenType.lparen));
      case ")".codePointAt(0):
        return new TokenVal(new Token(TokenType.rparen, TokenType.rparen));
      case "*".codePointAt(0):
        if (this.cur === "=".codePointAt(0)) {
          this.consume();
          return new TokenVal(
            new Token(TokenType.assignStar, TokenType.assignStar)
          );
        }
        return new TokenVal(new Token(TokenType.star, TokenType.star));
      case "+".codePointAt(0):
        if (this.cur === "=".codePointAt(0)) {
          this.consume();
          return new TokenVal(
            new Token(TokenType.assignPlus, TokenType.assignPlus)
          );
        }
        if (this.cur === "+".codePointAt(0)) {
          this.consume();
          return new TokenVal(
            new Token(TokenType.increment, TokenType.increment)
          );
        }
        return new TokenVal(new Token(TokenType.plus, TokenType.plus));
      case ",".codePointAt(0):
        return new TokenVal(new Token(TokenType.comma, TokenType.comma));
      case "-".codePointAt(0):
        if (this.cur === ">".codePointAt(0)) {
          this.consume();
          return new TokenVal(new Token(TokenType.arrow, TokenType.arrow));
        }
        if (this.cur === "-".codePointAt(0)) {
          this.consume();
          return new TokenVal(
            new Token(TokenType.decrement, TokenType.decrement)
          );
        }
        if (this.cur === "=".codePointAt(0)) {
          this.consume();
          return new TokenVal(
            new Token(TokenType.assignMinus, TokenType.assignMinus)
          );
        }
        return new TokenVal(new Token(TokenType.minus, TokenType.minus));
      case ".".codePointAt(0):
        if (this.cur === ".".codePointAt(0)) {
          this.consume();
          if (this.cur === "<".codePointAt(0)) {
            this.consume();
            return new TokenVal(
              new Token(TokenType.dotDotLt, TokenType.dotDotLt)
            );
          }
          return new TokenVal(new Token(TokenType.dotDot, TokenType.dotDot));
        }
        return new TokenVal(new Token(TokenType.dot, TokenType.dot));
      case "/".codePointAt(0):
        if (this.cur === "=".codePointAt(0)) {
          this.consume();
          return new TokenVal(
            new Token(TokenType.assignSlash, TokenType.assignSlash)
          );
        }
        return new TokenVal(new Token(TokenType.slash, TokenType.slash));
      case ":".codePointAt(0):
        if (this.cur === ":".codePointAt(0)) {
          this.consume();
          return new TokenVal(
            new Token(TokenType.doubleColon, TokenType.doubleColon)
          );
        }
        if (this.cur === "=".codePointAt(0)) {
          this.consume();
          return new TokenVal(
            new Token(TokenType.defAssign, TokenType.defAssign)
          );
        }
        return new TokenVal(new Token(TokenType.colon, TokenType.colon));
      case ";".charCodeAt(0):
        return new TokenVal(
          new Token(TokenType.semicolon, TokenType.semicolon)
        );
      case "<".charCodeAt(0):
        if (this.cur === "=".codePointAt(0)) {
          this.consume();
          if (this.cur === ">".codePointAt(0)) {
            this.consume();
            return new TokenVal(new Token(TokenType.cmp, TokenType.cmp));
          }
          return new TokenVal(new Token(TokenType.ltEq, TokenType.ltEq));
        }
        return new TokenVal(new Token(TokenType.lt, TokenType.lt));
      case "=".charCodeAt(0):
        if (this.cur === "=".codePointAt(0)) {
          this.consume();
          if (this.cur === "=".codePointAt(0)) {
            this.consume();
            return new TokenVal(new Token(TokenType.same, TokenType.same));
          }
          return new TokenVal(new Token(TokenType.eq, TokenType.eq));
        }
        return new TokenVal(new Token(TokenType.assign, TokenType.assign));
      case ">".charCodeAt(0):
        if (this.cur === "=".codePointAt(0)) {
          this.consume();
          return new TokenVal(new Token(TokenType.gtEq, TokenType.gtEq));
        }
        return new TokenVal(new Token(TokenType.gt, TokenType.gt));
      case "?".charCodeAt(0):
        if (this.cur === ":".codePointAt(0)) {
          this.consume();
          return new TokenVal(new Token(TokenType.elvis, TokenType.elvis));
        }
        if (this.cur === ".".codePointAt(0)) {
          this.consume();
          return new TokenVal(new Token(TokenType.safeDot, TokenType.safeDot));
        }
        if (
          this.cur === "-".codePointAt(0) &&
          this.peek === ">".codePointAt(0)
        ) {
          this.consume();
          this.consume();
          return new TokenVal(
            new Token(TokenType.safeArrow, TokenType.safeArrow)
          );
        }
        return new TokenVal(new Token(TokenType.question, TokenType.question));
      case "@".codePointAt(0):
        return new TokenVal(new Token(TokenType.at, TokenType.at));
      case "[".codePointAt(0):
        return new TokenVal(new Token(TokenType.lbracket, TokenType.lbracket));
      case "]".codePointAt(0):
        return new TokenVal(new Token(TokenType.rbracket, TokenType.rbracket));
      case "^".codePointAt(0):
        return new TokenVal(new Token(TokenType.caret, TokenType.caret));
      case "{".codePointAt(0):
        return new TokenVal(new Token(TokenType.lbrace, TokenType.lbrace));
      case "|".codePointAt(0):
        if (this.cur === "|".codePointAt(0)) {
          this.consume();
          return new TokenVal(
            new Token(TokenType.doublePipe, TokenType.doublePipe)
          );
        }
        return new TokenVal(new Token(TokenType.pipe, TokenType.pipe));
      case "}".codePointAt(0):
        return new TokenVal(new Token(TokenType.rbrace, TokenType.rbrace));
      case "~".codePointAt(0):
        return new TokenVal(new Token(TokenType.tilde, TokenType.tilde));
      case "$".codePointAt(0):
        return new TokenVal(new Token(TokenType.dollar, TokenType.dollar));
    }

    if (c === 0) return new TokenVal(new Token(TokenType.eof, TokenType.eof));

    throw new Error(
      `Unexpected symbol: ${String.fromCodePoint(c)} at ${this.line}:${
        this.col
      })`
    );
  }

  peekPeek(): string | null {
    return this.pos + 2 < this.buf.length ? this.buf[this.pos + 2] : null;
  }

  //
  // Consume the cur char and advance to next char in buffer:
  //  - updates cur and peek fields
  //  - updates the line and col count
  //  - end of file, sets fields to 0
  //
  consume(): void {
    // if cur is a line break, then advance line number,
    // because the char we are getting ready to make cur
    // is the first char on the next line
    if (this.cur === "\n".codePointAt(0)) {
      this.line++;
      this.col = 1;
      this.posOfLine = this.pos + 1;
    } else {
      this.col++;
    }

    // get the next character from the buffer, any
    // problems mean that we have read past the end
    this.cur = this.peek;
    this.pos++;
    if (this.pos + 1 < this.buf.length) {
      this.peek = this.buf[this.pos + 1].codePointAt(0)!; // next peek is cur+1
    } else {
      this.peek = 0;
    }
  }
}

/**************************************************
 * Quoted
 **************************************************/

enum QuotedType {
  normal = "Str literal ml",
  triple = "Str literal",
  uri = "Uri literal",
}

class Quoted {
  type: QuotedType;
  multiLine: boolean;

  constructor(type: QuotedType, ml: boolean) {
    this.type = type;
    this.multiLine = ml;
  }

  toStr(): string {
    return this.type;
  }

  isUri(): boolean {
    return this.type === QuotedType.uri;
  }

  isTriple(): boolean {
    return this.type === QuotedType.triple;
  }
}
