# SkySpark 3.x to 4.x Migration Guide

Complete guide for migrating SkySpark extensions and projects from 3.x to 4.0.

## Overview

SkySpark 4.0 introduces a fundamental architectural shift based on Xeto:

- **Core APIs moved**: `skyarcd` pod → Haxall `hx` pod
- **Extensions**: Now defined as Xeto libs with dotted names
- **Functions**: Defined in Xeto specs, stored outside database
- **Namespaces**: Dual namespace system (defs + Xeto)
- **Settings**: Moved from database to filesystem

## Major Breaking Changes

### 1. API Package Changes

**All core APIs moved from `skyarcd` to `hx`:**

```fantom
// 3.x
using skyarcd

class MyExt : Ext {
  override Void onStart() {
    sys := Sys.cur
    proj := Proj.cur
  }
}

// 4.0
using hx

class MyExt : Ext {
  override Void onStart() {
    sys := Sys.cur    // Now from hx pod
    proj := Proj.cur  // Now from hx pod
  }
}
```

**Key API migrations:**
- `skyarcd::Sys` → `hx::Sys`
- `skyarcd::Proj` → `hx::Proj`
- `skyarcd::Ext` → `hx::Ext`
- `skyarcd::Context` → `hx::Context`
- `skyarcd::User` → `hx::User`
- `skyarcd::ProjTest` → `hx::HxTest`

### 2. Extension Names & Lookup

**Extensions now use dotted Xeto lib names:**

```axon
// 3.x Axon
addExt("modbus")
libGet("modbus")

// 4.0 Axon
libAdd("hx.modbus")
exts.get("hx.modbus")
```

```fantom
// 3.x Fantom
Proj.cur.libs.get("task")

// 4.0 Fantom
Proj.cur.exts.get("hx.task")
```

### 3. Extension File Structure

**Old 3.x structure:**
```
myExt/
  build.fan        (ext.name, ext.depends)
  fan/
    MyExtLib.fan   (extends Ext)
```

**New 4.0 structure:**
```
myExt/
  build.fan        (indexed props only)
  lib/
    lib.trio       (metadata: dis, version, depends)
    lib.xeto       (xeto spec definitions)
    funcs.xeto     (axon function specs)
    apps.trio      (KEEP: Haystack 4 defs, apps)
    views.trio     (KEEP: Haystack 4 defs, views)
  fan/
    MyExtFuncs.fan (extends ExtObj, @Api funcs)
```

**A 4.0 pod carries two libs:**
- **Xeto lib** (e.g. `hx.hvac`): functions and specs. Functions must live here now.
- **Haystack 4 defs lib** (e.g. `hvac`): apps, views and templates. The Fresco UI
  still reads these from defs in 4.0.

Keep the defs lib in the pod. The `build.fan` index binds the two libs (see section 7).

### 3a. Apps, Views and Templates

- Apps, views and templates stay as Haystack 4 defs (`apps.trio`, `views.trio` etc.).
  There is no Xeto form for them yet.
- `convert4` converts `funcs.trio` to `funcs.xeto` only. It does not touch
  `apps.trio` or `views.trio`. Leave those files in place.
- Do not rewrite Axon views as Fantom views. It is not needed.
- The app shows in the App chooser only when the system can link the Xeto lib to the
  defs lib. Enabling the Xeto lib then also loads the defs lib.

Source: SkyFoundry forum #9090 "3.1 POD Views in 4.0" (Brian Frank, 2026-09-15).

### 4. Class Naming Conventions

**Extension main class renamed:**

```fantom
// 3.x
class MyExtLib : Ext {
  // ...
}

// 4.0
class MyExtExt : Ext {
  // ... (or MyExtFuncs if only functions)
}
```

**Function provider class:**
```fantom
// 4.0
class MyExtFuncs : ExtObj {
  
  @Api { admin = true }
  static Obj? myFunc(Context cx, Obj? arg) {
    // implementation
  }
}
```

### 5. Axon Function Definitions

**Old 3.x: Functions in database**

Functions were stored as `func` records in Folio database.

**New 4.0: Functions in Xeto specs**

```xeto
// lib/funcs.xeto
myAdd: Func {
  doc: "Add two numbers"
  a: Number
  b: Number
  returns: Number
  <axon:---
  (a, b) => a + b
  --->
}

myFantomFunc: Func {
  doc: "Calls Fantom implementation"
  input: Str
  returns: Str?
  // Implementation via @Api in Fantom
}
```

**Fantom function binding:**
```fantom
// 4.0
class MyExtFuncs : ExtObj {
  
  @Api
  static Str? myFantomFunc(Context cx, Str input) {
    // implementation
  }
}
```

### 6. Extension Settings

**Old 3.x: Database records**

Settings stored in Folio with `ext` tag.

**New 4.0: Filesystem trio files**

- System libs: `var/sys/ns/libs.txt`
- System settings: `var/sys/ns/settings.trio`
- Project libs: `var/proj/{name}/ns/libs.txt`
- Project settings: `var/proj/{name}/ns/settings.trio`

**Example settings.trio:**
```trio
hx.modbus: {
  dis: "Modbus Settings"
  pollingRate: 5sec
  timeout: 30sec
}
```

### 7. Build File Changes

**3.x build.fan:**
```fantom
using build

class Build : BuildPod {
  new make() {
    podName = "myExt"
    version = Version("1.0")
    depends = ["sys 1.0", "skyarcd 3.1"]
    srcDirs = [`fan/`]
    
    index = [
      "ext.name": "myExt",
      "ext.icon": "cog",
      "ext.depends": "task"
    ]
  }
}
```

**4.0 build.fan:**
```fantom
using build

class Build : BuildPod {
  new make() {
    podName = "myExt"
    version = Version("1.0")
    depends = ["sys 1.0", "hx 4.0"]
    srcDirs = [`fan/`]
    resDirs = [`lib/`]
    
    index = [
      "ph.lib": "myExt",                // Haystack 4 defs lib name
      "xeto.bindings": "myPrefix.myExt" // Xeto lib name
    ]
  }
}
```

**The two index keys name different libs:**
- `ph.lib` = defs lib name (apps, views, templates).
- `xeto.bindings` = Xeto lib name (functions, specs).

Together they tell the system: when the Xeto lib is enabled, include the defs lib.
Real example from the `hxHvac` pod:
```fantom
index = ["ph.lib":"hvac", "xeto.bindings":"hx.hvac"]
```
Enabling `hx.hvac` also loads the defs lib `hvac`. Without both keys, apps and views
from the defs lib do not appear.

**lib.trio (metadata):**
```trio
dis: "My Extension"
version: "1.0.0"
depends: [
  {lib: "sys"},
  {lib: "ph"},
  {lib: "hx"}
]
org: {
  dis: "My Organization"
  uri: "https://myorg.com"
}
```

### 8. Connector Changes

**Model name inference:**

Connector model names are now inferred from the library name's last segment:

- Library: `hx.energystar` → Model: `energystar`
- Library: `hx.bacnet` → Model: `bacnet`
- Library: `myco.customConn` → Model: `customConn`

**If you need a different model name (e.g., camelCase):**
```fantom
class MyConnExt : ConnExt {
  override Str modelName() { "customName" }
}
```

**Old connExt framework removed:**

Must use `hxConn` framework (introduced in 3.1.3).

### 9. Removed/Deprecated APIs

**Removed functions:**
- `degreeDayHisSrc()` (from 2.1)
- `invoke()` / `invokeAction()` (from 2.1)
- `watchSub()` / `watchUnsub()` (use `watchAdd()`/`watchRemove()`)

**Removed APIs:**
- `Context.filterPather` (deprecated)
- Haxall services axon and Fantom APIs

**Changed behavior:**
- `Folio.readById()` with trash flag now returns null instead of error
- Axon cannot combine dot with qnames: `"123.axon::toStr"` no longer works
- Log format changed to: `<rt:dotted.name>`

### 10. Namespace Management

**New Namespace App** provides views for:
- **Lib Status**: All libs in sys/proj namespace
- **Ext Status**: Extensions and their status
- **Sys Libs**: Manage system libraries (was Settings|SysMods)
- **Proj Libs**: Manage project libraries (was Settings|Exts)

## Step-by-Step Migration Process

### Phase 1: Update API Imports

1. **Change using statements:**
   ```fantom
   // Change this:
   using skyarcd
   
   // To this:
   using hx
   ```

2. **Update all API references** (usually automatic after import change)

### Phase 2: Choose Library Prefix

**Register your xeto lib prefix** to avoid conflicts:
- Examples: `myco`, `acme`, `smithCo`
- See SkySpark forum topic 8737 for registration

### Phase 3: Convert Extension Structure

1. **Keep the `ph.lib` indexed property (defs lib name):**
   ```fantom
   index = ["ph.lib": "myExt"]
   ```

2. **Rename main class:**
   ```fantom
   // From: MyExtLib
   // To:   MyExtFuncs (if only functions)
   //   or: MyExtExt (if full extension)
   ```

3. **Change base class:**
   ```fantom
   // From: extends Ext
   // To:   extends ExtObj (for funcs only)
   //   or: extends Ext (for full ext)
   ```

4. **Add @Api facet to all Axon-callable functions:**
   ```fantom
   @Api
   static Obj? myFunc(Context cx, Obj? arg) { ... }
   
   @Api { admin = true }
   static Obj? adminFunc(Context cx) { ... }
   ```

### Phase 4: Run Conversion Tool

```bash
# Convert extension metadata and functions
bin/fan skyarcd::Main convert4 ext myExt -libXeto -funcs
```

This generates:
- `lib/lib.xeto` - Xeto spec definitions
- `lib/funcs.xeto` - Axon function specs
- `lib/lib.trio` - Metadata

It does **not** convert `apps.trio` or `views.trio`. Keep them as defs (section 3a).

### Phase 5: Update Build File

Add to `build.fan`:
```fantom
index = [
  "ph.lib": "myExt",              // defs lib: apps, views, templates
  "xeto.bindings": "myco.myExt"   // xeto lib: functions
]

resDirs = [`lib/`]  // Include lib/ resources
```

Remove old metadata:
```fantom
// REMOVE these (now in lib.trio):
// "ext.name": "myExt"
// "ext.depends": "task"
// "ext.icon": "cog"
```

### Phase 6: Test & Validate

1. **Rebuild pod:**
   ```bash
   fan build.fan
   ```

2. **Install in test project:**
   ```axon
   libAdd("myco.myExt")
   ```

3. **Verify functions available:**
   ```axon
   myco.myExt::myFunc(...)
   ```

## Project Migration

### Converting 3.x Projects

**Can run 3.x databases in 4.0** but exts/funcs will be missing.

**Use convert4() function:**
```axon
// Export exts and funcs from 3.x format to 4.0
convert4()
```

This converts:
- Extension records → Xeto lib format
- Function records → Xeto spec format
- Settings → ns/settings.trio format

## Common Migration Patterns

### Pattern 1: Simple Extension with Functions

**3.x:**
```fantom
using skyarcd

class MyLib : Ext {
  @Axon
  static Int myAdd(Int a, Int b) { a + b }
}
```

**4.0:**
```fantom
using hx

class MyFuncs : ExtObj {
  @Api
  static Int myAdd(Context cx, Int a, Int b) { a + b }
}
```

**4.0 Xeto (lib/funcs.xeto):**
```xeto
myAdd: Func {
  doc: "Add two numbers"
  a: Number
  b: Number
  returns: Number
}
```

### Pattern 2: Extension with Settings

**3.x settings (in database):**
```trio
id: @myExt
ext
myExt
dis: "My Extension"
pollRate: 5sec
```

**4.0 settings (ns/settings.trio):**
```trio
myco.myExt: {
  dis: "My Extension"
  pollRate: 5sec
}
```

### Pattern 3: Connector Extension

**3.x:**
```fantom
using skyarcd
using hxConn

class MyConnLib : ConnExt {
  override Str connModel() { "myConn" }
}
```

**4.0:**
```fantom
using hx
using hxConn

class MyConnExt : ConnExt {
  // Model name auto-inferred from lib name
  // Override only if needed:
  // override Str modelName() { "myConn" }
}
```

## Troubleshooting

### Issue: Functions not appearing

**Cause**: Missing `@Api` facet or not registered in Xeto

**Solution**:
1. Add `@Api` to Fantom methods
2. Ensure function defined in `lib/funcs.xeto`
3. Rebuild and reinstall extension

### Issue: Extension not loading

**Cause**: Missing `xeto.bindings` index property

**Solution**:
```fantom
index = [
  "ph.lib": "myExt",
  "xeto.bindings": "myco.myExt"  // Add this
]
```

### Issue: App or views missing after migration

**Symptom**: Functions work, but the app is not in the App chooser and its views do
not show.

**Cause**: `convert4` did not move `apps.trio` / `views.trio`, and the pod does not
bind the Xeto lib to the defs lib.

**Solution**:
1. Keep `apps.trio` and `views.trio` in the pod as Haystack 4 defs.
2. Set both index keys: `"ph.lib": "<defs lib>"` and `"xeto.bindings": "<xeto lib>"`.
3. Rebuild the pod and enable the Xeto lib. The defs lib loads with it.

### Issue: Can't find old extension

**Cause**: Extension name changed from `myExt` to `myco.myExt`

**Solution**: Use full dotted name:
```axon
// Old: exts.get("myExt")
// New: exts.get("myco.myExt")
```

### Issue: Compilation errors

**Common fixes**:
- Change `using skyarcd` → `using hx`
- Change `ProjTest` → `HxTest`
- Update `libs.get()` → `exts.get()`
- Remove deprecated API calls

## Resources

- **convert4 tool**: Automated conversion helper
- **Haxall repo**: Reference implementations of core extensions
- **Namespace app**: Manage libs and extensions in UI
- **docHaxall::Exts**: Extension documentation
- **docHaxall::Namespace**: Namespace documentation

## Haxall 4.0.4 → 4.0.6 Changes That Affect Migration

From a source diff of `haxall-4.0.4/src` vs `haxall-4.0.6/src` (687 file-level changes).

**Axon body in `funcs.xeto` changed shape (4.0.5+):**
```xeto
// 4.0.4: full lambda in the axon tag
add1: Func { a: Number, b: Number, returns: Number
  <axon:"(a, b) => a + b">
}

// 4.0.6: params live in the spec; the axon tag holds only the body
add1: Func { a: Number, b: Number, returns: Number
  <axon:"a + b">
}
```
Multi-line bodies use the `<axon:--- ... --->` heredoc. Funcs are grouped under a
`+Funcs { ... }` block. `convert4 fix-axon-specs <dirs>` strips the params from
4.0.4-style specs, but does not move param defaults into the spec. Rerun
`convert4 ext` from the original `funcs.trio` when you can.

**`convert4 ext` gained options:**
- `-types`: writes `specs.xeto` from the ext's defs (entity types, enums, slots).
- `-doc`: converts `pod.fandoc` to `doc.md`.
- `-all`: everything (`lib.xeto`, `funcs.xeto`, `specs.xeto`, `doc.md`).
- Conn exts get `<connFeatures: {...}>` on the ext spec and a `hx.conn` depend.
- Still does **not** convert `apps.trio` / `views.trio` (skips `view`, `lib:`,
  `command:` defs on purpose).

**Pod/lib layout in 4.0.6 core libs:**
- `pod.fandoc` removed from every conn pod; `doc.md` in the xeto lib dir instead.
- New per-lib files: `specs.xeto` (types), `skills.xeto` + `skills/` (agent skills).
- `hxTools stub` templates: `funcs.trio`, `lib.trio`, `lib.fan`, `pod.fandoc`,
  `skyarc.trio` templates are gone; `funcs.xeto`, `lib.xeto`, `ext.fan`,
  `extConn.fan`, `doc.md` templates replace them. Use `hx stub` on 4.0.6 for a
  fresh ext skeleton.
- New exts: `hxComps`, `hxFile`, `hxRepo`, `hxSession`; `hx.hxd.file` lib is gone.
- Axon: `AxonExpr`, `TopFn`, `AxonRpc`, `AxonCompFunc` added; `ast/Comp*`,
  `comp/`, `template/` dirs removed from `core/axon`.
- Xeto: `XetoIO`, JSON reader/writer, JSON Schema and OpenAPI exporters,
  `CompanionCompiler`/`CompanionRecs`, remote repos (`xetoTools install/remote`).

## Alpha Period Notes

During alpha (before full UI/rules engine):

1. **Still need 3.1 defs** for (UI part still true in 4.0.6, see section 3a):
   - Current UI (Fresco: apps, views, templates)
   - hxConn framework
   - Linting/validation
   - Docgen

2. **Dual definition**: Define functions in both:
   - Old style (for defs/UI)
   - New Xeto style (for 4.0 runtime)

3. **Missing features**:
   - Replication enhancements
   - Live replica support
   - Some export features

## Quick Reference Card

| 3.x | 4.0 |
|-----|-----|
| `using skyarcd` | `using hx` |
| `skyarcd::Ext` | `hx::Ext` |
| `FooLib` | `FooExt` or `FooFuncs` |
| `addExt("modbus")` | `libAdd("hx.modbus")` |
| `libs.get("task")` | `exts.get("hx.task")` |
| `ext.name` index | `ph.lib` (defs lib) + `xeto.bindings` (xeto lib) |
| Funcs in database | Funcs in lib/funcs.xeto |
| `apps.trio` / `views.trio` | Unchanged: stay as defs |
| Settings in database | Settings in ns/settings.trio |
| `@Axon` facet | `@Api` facet |
| `ProjTest` | `HxTest` |
| `watchSub()` | `watchAdd()` |

## Next Steps

1. Review your extension dependencies
2. Choose and register your lib prefix
3. Update API imports to `hx`
4. Convert extension structure
5. Run `convert4` tool
6. Test thoroughly in alpha environment
7. Prepare for full 4.0 release
