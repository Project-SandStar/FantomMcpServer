import { Loc } from "../Loc";
import { TokenVal } from "../parser/TokenVal";
import { FacetDef } from "./FacetDef";
import { Node } from "./Node";

abstract class DefNode extends Node {
  abstract docDef?: DocDef; // lines of fandoc comment or null
  abstract flags?: TokenVal[]; // type/slot flags
  abstract facets?: FacetDef[]; // facet declarations or null

  constructor(loc: Loc) {
    super(loc);
  }
}

/**
 * Type or slot documentation in plain text fandoc format
 */
class DocDef extends Node {
  lines: string[];

  constructor(loc: Loc, lines: string[]) {
    super(loc);
    this.lines = lines;
  }

  text(): string {
    return this.lines.join("\n");
  }
}

export { DocDef, DefNode };
