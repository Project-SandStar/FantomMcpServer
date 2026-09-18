import { Loc } from "../Loc";
import { Node } from "./Node";
import { Stmt } from "./Stmt";

class Block extends Node {
  stmts: Stmt[];

  /**
   * @param loc Loc
   */
  constructor(loc: Loc) {
    super(loc);
    this.stmts = [];
  }

  /**
   * Append a statement
   *
   * @param stmt Stmt
   */
  add(stmt: Stmt): void {
    this.stmts.push(stmt);
  }

  /**
   * Append a list of statements
   *
   * @param stmts Stmt[]
   */
  addAll(stmts: Stmt[]): void {
    this.stmts = [...this.stmts, ...stmts];
  }
}

export { Block };
