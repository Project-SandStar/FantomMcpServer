// dump-symbols.fan — emit canonical symbols for a Fantom pod by reflection.
// Usage: fan scripts/dump-symbols.fan <podName>
// Output: pipe-delimited lines for simple Node parsing:
//   type|<podName>::<TypeName>|<file>|<line>|<isAbstract>|<isPublic>
//   method|<podName>::<TypeName>.<methodName>|<file>|<line>|<isStatic>|<isPublic>
//   field|<podName>::<TypeName>.<fieldName>|<file>|<line>|<isStatic>|<isPublic>
class DumpSymbols {
  Void main(Str[] args) {
    if (args.size < 1) { Env.cur.err.printLine("usage: fan dump-symbols.fan <podName>"); Env.cur.exit(2); return }
    pod := Pod.find(args[0], false)
    if (pod == null) { Env.cur.err.printLine("pod not found: " + args[0]); Env.cur.exit(3); return }
    pod.types.each |t| {
      // Skip synthetic types (closures, anonymous helpers) — Fantom compiler emits them with $ in the name.
      if (t.name.contains("\$")) return
      tFacets := t.facets
      tFile := facetVal(tFacets, "sys::SourceFile")
      tLine := facetVal(tFacets, "sys::SourceLine")
      echo("type|" + t.qname + "|" + (tFile ?: "") + "|" + (tLine ?: "0") + "|" + t.isAbstract + "|" + t.isPublic)
      t.methods.each |m| {
        if (m.parent !== t) return  // only methods declared on this type
        mFacets := m.facets
        mFile := facetVal(mFacets, "sys::SourceFile") ?: tFile
        mLine := facetVal(mFacets, "sys::SourceLine")
        echo("method|" + t.qname + "." + m.name + "|" + (mFile ?: "") + "|" + (mLine ?: "0") + "|" + m.isStatic + "|" + m.isPublic)
      }
      t.fields.each |f| {
        if (f.parent !== t) return
        fFacets := f.facets
        fFile := facetVal(fFacets, "sys::SourceFile") ?: tFile
        fLine := facetVal(fFacets, "sys::SourceLine")
        echo("field|" + t.qname + "." + f.name + "|" + (fFile ?: "") + "|" + (fLine ?: "0") + "|" + f.isStatic + "|" + f.isPublic)
      }
    }
  }

  // Helper: try to retrieve a facet value by qualified name.
  Str? facetVal(Facet[] facets, Str qname) {
    facets.each |fct| {
      // Facet has typeof for the facet type
      if (fct.typeof.qname == qname) {
        // SourceFile / SourceLine facets store value in `val` field — but they may not be exposed
        // (Fantom emits them only with -debug). Try via reflection.
        try {
          v := fct.typeof.field("val", false)
          if (v != null) return v.get(fct).toStr
        } catch {}
      }
    }
    return null
  }
}
