import { Loc } from "../Loc";
import { TokenVal } from "../parser/TokenVal";
import { DefNode, DocDef } from "./DefNode";
import { EnumDef } from "./EnumDef";
import { FacetDef } from "./FacetDef";
import { MethodDef } from "./MethodDef";

// TypeDef models a type definition for a class, mixin or enum
class TypeDef extends DefNode {
  //Identity
  name: string;

  //metadata
  override facets?: FacetDef[];
  override docDef?: DocDef;

  // structure
  override flags?: TokenVal[];
  isMixin: boolean = false;
  isEnum: boolean = false;

  // inheritance
  inheritsFrom?: TokenVal[];

  //slots
  slotDefs: Array<MethodDef> = [];
  enumDefs: EnumDef[] = [];

  constructor({
    loc,
    name,
    facets,
    flags,
    docDef,
    isEnum,
    isMixin,
  }: {
    loc: Loc;
    name: string;
    facets?: FacetDef[];
    flags?: TokenVal[];
    docDef?: DocDef;
    isEnum?: boolean;
    isMixin?: boolean;
  }) {
    super(loc);
    this.name = name;
    if (facets) this.facets = facets;
    if (flags) this.flags = flags;
    this.docDef = docDef;
    if (isMixin) this.isMixin = isMixin;
    if (isEnum) this.isEnum = isEnum;
  }

  /**
   * add mixin or base class that the typedef inherits from
   */
  addBase(base: TokenVal) {
    if (!this.inheritsFrom) {
      this.inheritsFrom = [];
    }
    this.inheritsFrom.push(base);
  }

  /**
   * add an enum defination
   */
  addEnum(_enum: EnumDef) {
    this.enumDefs.push(_enum);
  }

  addSlot(slot: MethodDef) {
    this.slotDefs.push(slot);
  }
}

export { TypeDef };
