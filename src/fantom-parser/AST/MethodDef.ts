import { Loc } from "../Loc";
import { TokenVal } from "../parser/TokenVal";
import { Block } from "./Block";
import { DefNode, DocDef } from "./DefNode";
import { FacetDef } from "./FacetDef";
import { ParamDef } from "./ParamDef";

class MethodDef extends DefNode {
  name?: string;
  params!: ParamDef[];
  returnType: TokenVal;

  facets?: FacetDef[];
  flags?: TokenVal[];
  docDef?: DocDef;

  code?: Block;

  constructor({
    loc,
    name,
    facets,
    flags,
    docDef,
    code,
    returnType,
  }: {
    loc: Loc;
    name?: string;
    facets?: FacetDef[];
    flags?: TokenVal[];
    docDef?: DocDef;
    code?: Block;
    returnType: TokenVal;
  }) {
    super(loc);
    this.name = name;
    this.returnType = returnType;
    this.facets = facets;
    this.flags = flags;
    this.docDef = docDef;
    this.code = code;
  }

  static makeStaticInit({ loc }: { loc: Loc }) {
    return new MethodDef({ loc, name: "static$init" });
  }

  addCodeBlock(code: Block) {
    this.code = code;
  }
}

export { MethodDef };
