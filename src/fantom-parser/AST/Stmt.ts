import { Loc } from "../Loc";
import { TokenVal } from "../parser/TokenVal";
import { Block } from "./Block";
import { Expr } from "./Expr";
import { Node } from "./Node";

/**
 * Stmt
 */
abstract class Stmt extends Node {
  id: StmtId;

  constructor(loc: Loc, id: StmtId) {
    super(loc);

    this.id = id;
  }
}

// =======================================================
// ExprStmt
// =======================================================
/**
 * ExprStmt is a statement with a stand along expression such
 * as an assignment or method call.
 */
class ExprStmt extends Stmt {
  expr: Expr;

  /**
   * @param expr Expr
   */
  constructor(expr: Expr) {
    super(expr.loc, StmtId.expr);
    this.expr = expr;
  }
}

// =======================================================
// LocalDefStmt
// =======================================================

/**
 * LocalDefStmt models a local variable declaration and its
 * optional initialization expression
 */
class LocalDefStmt extends Stmt {
  name: string; // variable name
  type: string;
  init!: Expr | undefined; // rhs of init; in ResolveExpr it becomes full assign expr

  /**
   * @param loc Loc
   *
   * @param type string
   *
   * @param name string
   */
  constructor(loc: Loc, type: string, name: string = "") {
    super(loc, StmtId.localDef);
    this.name = name;
    this.type = type;
  }
}

// =======================================================
// IfStmt
// =======================================================
/**
 * IfStmt models an if or if/else statement
 */
class IfStmt extends Stmt {
  condition: Expr; // test expression
  trueBlock: Block; // block to execute if condition true
  falseBlock?: Block; // else clause

  /**
   * @param loc Loc
   *
   * @param condition Expr
   *
   * @param trueBlock Block
   */
  constructor(loc: Loc, condition: Expr, trueBlock: Block) {
    super(loc, StmtId.ifStmt);
    this.condition = condition;
    this.trueBlock = trueBlock;
  }
}

// =======================================================
// Return Statement
// =======================================================
/**
 * ReturnStmt returns from the method
 */
class ReturnStmt extends Stmt {
  expr?: Expr;

  /**
   * @param loc Loc
   *
   * @param expr Expr | undefined
   */
  constructor(loc: Loc, expr?: Expr) {
    super(loc, StmtId.returnStmt);
    this.expr = expr;
  }
}

// =======================================================
// ThrowStmt
// =======================================================
class ThrowStmt extends Stmt {
  exception: Expr; // exception to throw

  /**
   * @param loc Loc
   *
   * @param exception Expr
   */
  constructor(loc: Loc, exception: Expr) {
    super(loc, StmtId.throwStmt);
    this.exception = exception;
  }
}

// =======================================================
// ForStmt
// =======================================================
/**
 * ForStmt models a for loop of the Stmt format:
 *  for(init; condition; update) block
 */
class ForStmt extends Stmt {
  init?: Stmt; // loop initialization
  condition?: Expr; // loop condition
  update?: Expr; // loop update
  block?: Block; // code to run inside loop

  /**
   * @param loc Loc
   */
  constructor(loc: Loc) {
    super(loc, StmtId.forStmt);
  }
}

// =======================================================
// WhileStmt
// =======================================================
/**
 * WhileStmt models a while loop of the format:
 *  while(condition) block
 */
class WhileStmt extends Stmt {
  condition: Expr; // loop condition
  block: Block; // code to run inside loop

  /**
   * @param loc Loc
   *
   * @param condition Expr
   *
   * @param block Block
   */
  constructor(loc: Loc, condition: Expr, block: Block) {
    super(loc, StmtId.whileStmt);
    this.condition = condition;
    this.block = block;
  }
}

// =======================================================
// BreakStmt
// =======================================================
/**
 * BreakStmt breaks out of a while/for loop.
 */
class BreakStmt extends Stmt {
  /**
   * @param loc Loc
   */
  constructor(loc: Loc) {
    super(loc, StmtId.breakStmt);
  }
}

// =======================================================
// ContinueStmt
// =======================================================
/**
 * ContinueStmt continues a while/for loop
 */
class ContinueStmt extends Stmt {
  /**
   * @param loc Loc
   */
  constructor(loc: Loc) {
    super(loc, StmtId.continueStmt);
  }
}

// =======================================================
// TryStmt
// =======================================================
/**
 * TryStmt models a try/catch/finally block
 */
class TryStmt extends Stmt {
  block?: Block; // body of try block
  catches: Catch[]; // list of catch clauses
  finallyBlock?: Block; // body of finally block or undefined

  /**
   * @param loc Loc
   */
  constructor(loc: Loc) {
    super(loc, StmtId.tryStmt);
    this.catches = [];
  }
}

/**
 * Catch models a single catch clause of a TryStmt
 */
class Catch extends Node {
  errType?: TokenVal; // Err type to catch or undefined for catch-all
  errVariable?: TokenVal; // name of err local variable
  block?: Block; // body of catch block

  /**
   * @param loc Loc
   */
  constructor(loc: Loc) {
    super(loc);
  }
}

// =======================================================
// SwitchStmt
// =======================================================
class SwitchStmt extends Stmt {
  condition: Expr; // test expression
  cases: Case[]; // list of case blocks
  defaultBlock?: Block; // default block (or undefined)

  /**
   * @param loc Loc
   *
   * @param condition Expr
   */
  constructor(loc: Loc, condition: Expr) {
    super(loc, StmtId.switchStmt);
    this.condition = condition;
    this.cases = [];
  }
}

/**
 * Case models a single case block of a SwitchStmt
 */
class Case extends Node {
  cases: Expr[]; // list of case target (literal expressions)
  block?: Block; // code to run for case

  /**
   * @param loc Loc
   */
  constructor(loc: Loc) {
    super(loc);
    this.cases = [];
  }
}

enum StmtId {
  nop,
  expr,
  localDef,
  ifStmt,
  returnStmt,
  throwStmt,
  forStmt,
  whileStmt,
  breakStmt,
  continueStmt,
  tryStmt,
  switchStmt,
}

export {
  Stmt,
  StmtId,
  ExprStmt,
  LocalDefStmt,
  IfStmt,
  ReturnStmt,
  ThrowStmt,
  ForStmt,
  WhileStmt,
  BreakStmt,
  ContinueStmt,
  TryStmt,
  Catch,
  SwitchStmt,
  Case,
};
