# SkySpark 3.x to 4.0 API Migration Reference

Complete mapping of deprecated 3.x APIs to their 4.0 equivalents.

## Pod Changes

### Core API Pod

```fantom
// 3.x
using skyarcd

// 4.0
using hx
```

## Type Migrations

### System & Runtime Types

| 3.x Type | 4.0 Type | Notes |
|----------|----------|-------|
| `skyarcd::Sys` | `hx::Sys` | Now extends Runtime |
| `skyarcd::Proj` | `hx::Proj` | Now extends Runtime |
| `skyarcd::Context` | `hx::Context` | Unchanged API, new pod |
| `skyarcd::User` | `hx::User` | Unchanged API |
| `skyarcd::ProjTest` | `hx::HxTest` | New test framework |
| `hx::HxUser` | `hx::User` | Simplified name |

### Extension Types

| 3.x Type | 4.0 Type | Notes |
|----------|----------|-------|
| `skyarcd::Ext` | `hx::Ext` | Main extension type |
| `hx::HxLib` | `hx::Ext` | Renamed for consistency |
| `hx::HxLibWeb` | `hx::ExtWeb` | Web extension base |
| `{ext}Lib` class | `{ext}Ext` or `{ext}Funcs` | Naming convention change |

### Function Provider Types

| 3.x Pattern | 4.0 Pattern | Notes |
|-------------|-------------|-------|
| `extends Ext` | `extends ExtObj` | For function-only extensions |
| `@Axon` facet | `@Api` facet | New facet for exported functions |

## Method Migrations

### Extension Lookup

```fantom
// 3.x - by simple name
Proj.cur.libs.get("task")
Proj.cur.libs.get("modbus")

// 4.0 - by dotted xeto name
Proj.cur.exts.get("hx.task")
Proj.cur.exts.get("hx.modbus")
```

### Axon Function Calls

```axon
-- 3.x
addExt("modbus")
libGet("task")

-- 4.0
libAdd("hx.modbus")
exts.get("hx.task")
```

### Function Metadata

```fantom
// 3.x
func := Proj.cur.funcs.get("myFunc")
lib := func->lib  // lib name
name := func->name

// 4.0
func := Proj.cur.funcs.get("myco.myExt::myFunc")
qname := func.qname  // qualified name instead
```

### Watch APIs

```axon
-- 3.x (DEPRECATED)
watchSub(dis=="My Watch")
watchUnsub(dis=="My Watch")

-- 4.0
watchAdd(dis=="My Watch")
watchRemove(dis=="My Watch")
```

### Connector APIs

```fantom
// 3.x
conn.connDupRef("modbus")
conn.connPointsVia("bacnet")

// 4.0 - use full dotted ext name
conn.connDupRef("hx.modbus")
conn.connPointsVia("hx.bacnet")
```

## Removed APIs

### Deprecated Functions (REMOVED)

```axon
-- REMOVED - from SkySpark 2.1
degreeDayHisSrc()
invoke()
invokeAction()

-- REMOVED - replaced by watchAdd/watchRemove
watchSub()
watchUnsub()
```

### Deprecated Methods (REMOVED)

```fantom
// REMOVED
Context.filterPather  // deprecated method

// REMOVED - Haxall specific
HxServices.axon
HxServices.fantom
```

## Behavior Changes

### Folio.readById with Trash

```fantom
// 3.x - throws exception if not found
rec := folio.readById(id, true)

// 4.0 - returns null if not found in trash
rec := folio.readById(id, true)
if (rec == null) {
  // handle not found
}
```

### Axon QName with Dot Operator

```axon
-- 3.x - ALLOWED
123.axon::toStr

-- 4.0 - NO LONGER ALLOWED
-- Must separate:
val: 123
str: val.toStr
```

### Log Message Format

```fantom
// 3.x
log.info("MyLib", "message")
// Output: [MyLib] message

// 4.0
log.info("myco.myLib", "message")
// Output: <rt:myco.myLib> message
```

## Function Definition Changes

### Axon Functions in Database → Xeto

**3.x - Database Record:**
```trio
id: @myFunc
func
name: "myFunc"
lib: "myExt"
src: "(a, b) => a + b"
doc: "Add two numbers"
```

**4.0 - Xeto Spec:**
```xeto
// lib/funcs.xeto
myFunc: Func {
  doc: "Add two numbers"
  a: Number
  b: Number
  returns: Number
  <axon:---
  (a, b) => a + b
  --->
}
```

### Fantom Function Binding

**3.x:**
```fantom
class MyLib : Ext {
  @Axon
  static Str doSomething(Str arg) {
    // implementation
  }
}
```

**4.0:**
```fantom
class MyFuncs : ExtObj {
  @Api
  static Str doSomething(Context cx, Str arg) {
    // implementation
  }
}
```

**Key Changes:**
- `@Axon` → `@Api`
- Must accept `Context` as first parameter
- Class extends `ExtObj` instead of `Ext`

## Extension Metadata Changes

### Build File Index Properties

**3.x:**
```fantom
index = [
  "ext.name": "myExt",
  "ext.icon": "cog",
  "ext.depends": "task, modbus"
]
```

**4.0:**
```fantom
index = [
  "ph.lib": "myco.myExt",
  "xeto.bindings": "myco.myExt"
]
```

### Metadata Location

**3.x - In build.fan index:**
- Extension name
- Dependencies
- Icon
- Display name
- Documentation

**4.0 - In lib/lib.trio:**
```trio
dis: "My Extension"
version: "1.0.0"
icon: "cog"
depends: [
  {lib: "hx.task"},
  {lib: "hx.modbus"}
]
doc: "Extension documentation"
org: {
  dis: "My Company"
  uri: "https://mycompany.com"
}
```

## Extension Settings Changes

### Settings Storage

**3.x - In Folio Database:**
```trio
id: @myExtSettings
ext
myExt
dis: "My Extension"
pollRate: 5sec
maxRetries: 3
```

**4.0 - In Filesystem (ns/settings.trio):**
```trio
myco.myExt: {
  dis: "My Extension"
  pollRate: 5sec
  maxRetries: 3
}
```

**Locations:**
- System: `var/sys/ns/settings.trio`
- Project: `var/proj/{projName}/ns/settings.trio`

### Accessing Settings

```fantom
// 3.x
settings := Proj.cur.readByName("myExt")
pollRate := settings->pollRate

// 4.0
ext := Proj.cur.exts.get("myco.myExt")
settings := ext.settings
pollRate := settings->pollRate
```

## Connector Changes

### Model Name Resolution

**3.x - Explicit model name:**
```fantom
class MyConnLib : ConnExt {
  override Str connModel() { "myConn" }
}
```

**4.0 - Auto-inferred from lib name:**
```fantom
// Library: myco.customConn
// Model: customConn (last segment, lowercase)

class MyConnExt : ConnExt {
  // Model auto-inferred
  // Only override if different from lib name:
  override Str modelName() { "myConn" }
}
```

### Connector Framework

**3.x - Old connExt (REMOVED):**
```fantom
using connExt  // NO LONGER SUPPORTED
```

**4.0 - Must use hxConn:**
```fantom
using hxConn

class MyConnExt : ConnExt {
  // Use hxConn framework
}
```

**Migration:** All old `connExt` connectors must be migrated to `hxConn` framework introduced in 3.1.3.

## Testing Changes

### Test Class

**3.x:**
```fantom
using skyarcd

class MyTest : ProjTest {
  Void test() {
    proj := Proj.cur
    // test code
  }
}
```

**4.0:**
```fantom
using hx

class MyTest : HxTest {
  Void test() {
    proj := Proj.cur
    // test code
  }
}
```

## Namespace Changes

### Library Management UI

**3.x Locations:**
- Settings → SysMods (system extensions)
- Settings → Exts (project extensions)

**4.0 Locations:**
- Namespace → Sys Libs (system libraries)
- Namespace → Proj Libs (project libraries)
- Namespace → Lib Status (all libraries)
- Namespace → Ext Status (extension status)

### Programmatic Access

**3.x:**
```axon
-- List all extensions
readAll(ext)

-- Get extension record
read(ext and name=="modbus")
```

**4.0:**
```axon
-- List all extensions (Fantom API)
-- No longer in database

-- Get extension
exts.get("hx.modbus")
```

## Quick Migration Checklist

### Code Changes

- [ ] Change `using skyarcd` → `using hx`
- [ ] Update `ProjTest` → `HxTest`
- [ ] Change `@Axon` → `@Api`
- [ ] Add `Context cx` parameter to @Api functions
- [ ] Update `libs.get()` → `exts.get()`
- [ ] Use dotted names: `"modbus"` → `"hx.modbus"`
- [ ] Change `watchSub/watchUnsub` → `watchAdd/watchRemove`
- [ ] Update connector framework: `connExt` → `hxConn`

### File Structure Changes

- [ ] Create `lib/` directory
- [ ] Move metadata to `lib/lib.trio`
- [ ] Create `lib/lib.xeto` for specs
- [ ] Create `lib/funcs.xeto` for functions
- [ ] Update build.fan `index` properties
- [ ] Add `resDirs = [\`lib/\`]` to build.fan
- [ ] Rename `{Ext}Lib` → `{Ext}Ext` or `{Ext}Funcs`

### Metadata Changes

- [ ] Remove `ext.name` from build.fan
- [ ] Remove `ext.depends` from build.fan
- [ ] Remove `ext.icon` from build.fan
- [ ] Add `ph.lib` index property
- [ ] Add `xeto.bindings` index property
- [ ] Create lib.trio with metadata

### Function Changes

- [ ] Convert database funcs to Xeto specs
- [ ] Add type information to Xeto specs
- [ ] Update Fantom function signatures
- [ ] Add `@Api` facets
- [ ] Ensure `Context` parameter present

### Testing

- [ ] Rebuild pod: `fan build.fan`
- [ ] Install in test project: `libAdd("myco.myExt")`
- [ ] Verify functions: `myco.myExt::myFunc()`
- [ ] Check settings load correctly
- [ ] Test all API calls
- [ ] Validate connector operations (if applicable)

## Example: Complete Migration

### Before (3.x)

**build.fan:**
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

**fan/MyExtLib.fan:**
```fantom
using skyarcd

class MyExtLib : Ext {
  @Axon
  static Int add(Int a, Int b) { a + b }
  
  override Void onStart() {
    proj := Proj.cur
    task := proj.libs.get("task")
  }
}
```

### After (4.0)

**build.fan:**
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
      "ph.lib": "myco.myExt",
      "xeto.bindings": "myco.myExt"
    ]
  }
}
```

**lib/lib.trio:**
```trio
dis: "My Extension"
version: "1.0.0"
icon: "cog"
depends: [
  {lib: "hx.task"}
]
```

**lib/funcs.xeto:**
```xeto
add: Func {
  doc: "Add two numbers"
  a: Number
  b: Number
  returns: Number
}
```

**fan/MyExtFuncs.fan:**
```fantom
using hx

class MyExtExt : Ext {
  override Void onStart() {
    proj := Proj.cur
    task := proj.exts.get("hx.task")
  }
}

class MyExtFuncs : ExtObj {
  @Api
  static Int add(Context cx, Int a, Int b) { a + b }
}
```

## See Also

- **skyspark-4x-migration.md** - Complete migration guide
- **xeto-spec-guide.md** - Xeto specification reference
- **haxall-ext-development.md** - Extension development guide
