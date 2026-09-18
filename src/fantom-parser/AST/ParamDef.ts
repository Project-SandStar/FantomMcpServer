import { Node } from "./Node";
import { Expr } from "./Expr";
import { Loc } from "../Loc";

class ParamDef extends Node {
  name: string; // variable name
  type: string; // variable type
  def?: Expr; // default value

  constructor({
    loc,
    name,
    type,
    def,
  }: {
    loc: Loc;
    name: string;
    type: string;
    def?: Expr;
  }) {
    super(loc);
    this.name = name;
    this.type = type;
    this.def = def;
  }
}

export { ParamDef };
