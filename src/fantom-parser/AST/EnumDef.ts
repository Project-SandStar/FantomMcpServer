import { Loc } from "../Loc";
import { DocDef } from "./DefNode";
import { FacetDef } from "./FacetDef";
import { Node } from "./Node";

class EnumDef extends Node {
  doc?: DocDef;
  facets: FacetDef[] = [];
  name: string;
  ordinal: number;
  ctorArgs: Array<Object> = [];

  constructor({
    loc,
    doc,
    facets,
    name,
    ordinal,
  }: {
    loc: Loc;
    doc?: DocDef;
    facets?: FacetDef[];
    name: string;
    ordinal: number;
  }) {
    super(loc);
    this.doc = doc;
    if (facets) this.facets = facets;
    this.name = name;
    this.ordinal = ordinal;
  }

  addCtorArg(arg: Object) {
    this.ctorArgs.push(arg);
  }
}

export { EnumDef };
