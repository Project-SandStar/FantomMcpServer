# MCP Fantom Server - SkySpark 4.0 Migration Ready

## Status: Phase 1 Complete ✅

The MCP server is now equipped with comprehensive SkySpark 3.x to 4.0 migration knowledge and is ready to assist with migration projects.

## What's Available Now

### Migration Knowledge Base (3 Complete Guides)

1. **skyspark-4x-migration.md** - Complete Migration Guide
   - Architectural changes overview
   - Step-by-step migration process
   - All breaking changes documented
   - Common patterns and troubleshooting
   - Quick reference card

2. **api-migration-reference.md** - API Mapping Reference
   - Complete type migrations (skyarcd → hx)
   - Method migrations with examples
   - Removed/deprecated APIs list
   - Before/after code examples
   - Migration checklist

3. **xeto-spec-guide.md** - Xeto Specification Guide
   - lib.trio metadata format
   - lib.xeto type specifications
   - funcs.xeto function definitions
   - settings.xeto schema patterns
   - Complete connector example
   - Best practices

### MCP Resources (7 Total)

Access via MCP resource URIs:
- `workflow://create-pod` - Creating Fantom pods
- `workflow://use-fanr` - Using fanr package manager
- `workflow://haxall-basics` - Haxall development
- `workflow://unit-testing` - Writing tests
- `workflow://skyspark-4x-migration` - 4.0 migration guide ⭐
- `workflow://api-migration-reference` - API mappings ⭐
- `workflow://xeto-spec-guide` - Xeto specs ⭐

### MCP Tools (4 Working)

1. `searchFantomDocs` - Search Fantom API documentation
2. `getFantomType` - Get detailed type information
3. `listFantomPods` - List available Fantom pods
4. `refreshIndex` - Rebuild documentation index

## How to Use for Migration

### Scenario 1: Understanding Breaking Changes

**Ask AI:**
"What changed between SkySpark 3.x and 4.0 for extensions?"

**AI will:**
- Access `workflow://skyspark-4x-migration`
- Explain core architectural changes
- Show code examples
- List migration steps

### Scenario 2: API Conversion

**Ask AI:**
"How do I convert this 3.x code to 4.0?"
```fantom
using skyarcd
class MyLib : Ext {
  @Axon static Int add(Int a, Int b) { a + b }
}
```

**AI will:**
- Access `workflow://api-migration-reference`
- Show exact 4.0 equivalent
- Explain required changes
- Provide build.fan updates

### Scenario 3: Writing Xeto Specs

**Ask AI:**
"How do I define an Axon function in Xeto with parameters and return type?"

**AI will:**
- Access `workflow://xeto-spec-guide`
- Show funcs.xeto syntax
- Provide examples with types
- Show corresponding Fantom code

### Scenario 4: Extension Conversion

**Ask AI:**
"Convert my 3.x extension 'myExt' to 4.0 format"

**AI will:**
- Show build.fan changes
- Create lib.trio template
- Generate lib.xeto structure
- Show funcs.xeto format
- List all required steps

## What's Next (Upcoming Phases)

### Phase 2: Automated Code Analysis (2-3 days)

**Goal:** AI can analyze actual Fantom code and detect 3.x patterns

**New Tools:**
- `analyzeLegacyCode` - Scan .fan file for 3.x patterns
  - Detect `using skyarcd`
  - Find `@Axon` facets
  - Identify deprecated APIs
  - Check ext.name patterns

- `suggestMigration` - Show specific fixes
  - Input: File path + detected issue
  - Output: Exact code replacement

- `validateExtStructure` - Check if ext follows 4.0 structure
  - Verify lib/ directory exists
  - Check for lib.trio, funcs.xeto
  - Validate build.fan indexed props

**Implementation:**
- Simple regex-based pattern matching
- No full AST parsing needed
- Fast and reliable detection

### Phase 3: Xeto Generation (2-3 days)

**Goal:** AI can generate Xeto specs from existing code

**New Tools:**
- `generateLibTrio` - Create lib.trio from build.fan
  - Extract metadata
  - Format dependencies
  - Generate org info

- `convertFuncToXeto` - Convert Fantom/Axon func to Xeto
  - Parse @Axon/@Api functions
  - Extract parameters and types
  - Generate funcs.xeto entry

- `generateSettingsXeto` - Create settings schema
  - Analyze ext settings usage
  - Generate type-safe schema

**Implementation:**
- Template-based generation
- Smart defaults
- User can refine output

### Phase 4: Simplified Parser (Future)

**Goal:** Better code understanding for complex cases

**Extract Only:**
- Class/mixin/enum definitions
- Method signatures (name, params, return type)
- Field declarations (type, name, facets)
- Inheritance chains

**Skip:**
- Expression parsing
- Statement parsing
- Type checking
- Bytecode generation

**Why Later:**
Pattern matching + templates cover 80% of cases. Full parser only needed for edge cases.

## Testing the MCP

### 1. Start the Server

```bash
cd /Users/apple/Documents/Docs/Work/mcpfantom
npm start
```

### 2. Configure in Claude Desktop

Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "fantom": {
      "command": "node",
      "args": ["/Users/apple/Documents/Docs/Work/mcpfantom/build/index.js"]
    }
  }
}
```

### 3. Test Queries

Try these in Claude:
- "Explain the SkySpark 3.x to 4.0 migration process"
- "What's the new extension structure in SkySpark 4.0?"
- "How do I write Xeto function specifications?"
- "Show me how to migrate from skyarcd to hx"
- "What changed with extension naming in 4.0?"

## Migration Workflow Recommendations

### For Each Extension:

1. **Review** - Use AI to understand breaking changes
2. **Plan** - Ask AI to outline migration steps
3. **Convert** - Use AI to show code transformations
4. **Validate** - Check structure with AI guidance
5. **Test** - Verify in 4.0 alpha environment

### Priority Order:

1. **Simple function-only extensions** - Easiest to convert
2. **Extensions with settings** - Need namespace migration
3. **Connectors** - Require model name updates
4. **Complex extensions** - May need custom handling

## Key Knowledge Captured

### Breaking Changes ✅
- Pod migrations (skyarcd → hx)
- Extension naming (simple → dotted)
- Function definitions (database → Xeto)
- Settings location (Folio → filesystem)
- API changes (complete mapping)

### New Concepts ✅
- Xeto library structure
- lib.trio metadata format
- funcs.xeto syntax
- Namespace management
- Extension conversion process

### Patterns ✅
- Simple extensions
- Connector extensions
- Function-only extensions
- Settings management
- Axon vs Fantom functions

## Success Metrics

**Current Capabilities:**
- ✅ Explain all breaking changes
- ✅ Show API migrations
- ✅ Generate Xeto examples
- ✅ Provide migration checklist
- ✅ Answer "how do I" questions

**Ready For:**
- ✅ Understanding 4.0 architecture
- ✅ Planning migrations
- ✅ Writing Xeto specs
- ✅ Converting simple code
- ✅ Troubleshooting issues

**Next Level (Phase 2+):**
- 🚧 Automated code scanning
- 🚧 Direct file analysis
- 🚧 Xeto generation from code
- 🚧 Validation checks

## Resources for Developers

**Internal:**
- `/workflows/skyspark-4x-migration.md`
- `/workflows/api-migration-reference.md`
- `/workflows/xeto-spec-guide.md`

**External (mentioned in guides):**
- SkySpark forum topic 8737 (lib prefix registration)
- Haxall GitHub repo (reference implementations)
- convert4 command-line tool (automated conversion)
- YouTube videos (architecture overview, namespace app, etc.)

## Summary

**The MCP is now a comprehensive SkySpark 4.0 migration assistant.** It has deep knowledge of:
- All breaking changes
- Complete API mappings
- Xeto specification syntax
- Extension conversion process
- Best practices and patterns

**AI assistants using this MCP can now:**
- Guide developers through migrations
- Explain architectural changes
- Show code transformations
- Generate Xeto specs
- Troubleshoot common issues

**Ready to start migrating SkySpark 3.x projects to 4.0!** 🚀
