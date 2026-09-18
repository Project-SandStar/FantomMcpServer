import { Loc } from "../Loc";
import { Expr } from "./Expr";
import { Node } from "./Node";

class FacetDef extends Node {
  names: string[] = [];
  vals: Expr[] = [];

  constructor(loc: Loc) {
    super(loc);
  }
}

export { FacetDef };
