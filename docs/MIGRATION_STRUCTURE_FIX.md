# Migration Structure Fixes - Matching SkySpark 4.0.3

Based on analysis of `haxall/src/ext/hxTask`, the migration tool has been updated to match the real SkySpark 4.0 structure.

## Key Changes

### 1. **lib.trio Format** ✅

**Before (Incorrect):**
```trio
dis: "taskLib"
version: "4.0.0"
doc: "Task management"

depends: [
  {lib: "sys"},
  {lib: "ph"},
  {lib: "hx"}
]

org: {
  dis: "AKBIN"
  uri: "https://akbin.com"
}
```

**After (Correct - matches hxTask):**
```trio
--------------------------------------------------------------------------
def: ^lib:akbin.task
depends: [^lib:ph, ^lib:hx]
typeName:"hxTask::TaskExt"
doc: "Task management"
--------------------------------------------------------------------------
```

**Key Differences:**
- Uses `def: ^lib:` format instead of `dis:`
- Depends array uses `^lib:name` syntax (no braces)
- Includes `typeName` pointing to the Ext class
- Uses dashes as separators
- No version or org section in lib.trio

---

### 2. **build.fan Index Order** ✅

**Before (Incorrect):**
```fantom
index = [
  "ph.lib": "akbin.task",
  "xeto.bindings": "akbin.task"
]
```

**After (Correct - matches hxTask):**
```fantom
index = ["xeto.bindings":"akbin.task", "ph.lib": "task"]
```

**Key Differences:**
- `xeto.bindings` comes **first** (not second)
- `xeto.bindings` uses **full qualified name** (`akbin.task`)
- `ph.lib` uses **short library name only** (`task`, not `akbin.task`)
- Single line format, not multi-line array

---

### 3. **Library Name Case** ✅

**Before:**
```fantom
podName = "TaskLib"
// lib name was: akbin.TaskLib
```

**After:**
```fantom
podName = "hxTask"  // Keep original case for pod
// lib name is: akbin.task (lowercase!)
```

**Key Rule:**
- Pod name keeps original case (`hxTask`)
- Library name is **lowercase** (`task`)
- Qualified name uses lowercase (`akbin.task`)

---

### 4. **File Structure - Ext + Funcs Split** ✅

**SkySpark 4.0 requires separate files:**

```
fan/
  TaskExt.fan      ← Extension class (extends ExtObj or Ext)
  TaskFuncs.fan    ← All @Api functions (static)
  Task.fan         ← Domain/helper classes (if any)
  Errs.fan         ← Error classes (if any)
```

**Migration tool now:**
1. Detects files with both Ext class + @Api functions
2. Splits into `FooExt.fan` and `FooFuncs.fan`
3. Moves @Api functions to `FooFuncs` const class
4. Keeps Ext class in `FooExt.fan`
5. Removes old combined file

**Example Split:**

**Before (combined):**
```fantom
// FooLib.fan
class FooLib : Ext {
  // extension logic
}

@Api
static Str doSomething(Context cx) { ... }
```

**After (split):**

**FooExt.fan:**
```fantom
using hx

class FooExt : Ext {
  // extension logic
}
```

**FooFuncs.fan:**
```fantom
using hx

**
** Foo Axon functions
**
const class FooFuncs
{
  @Api
  static Str doSomething(Context cx) { ... }
}
```

---

### 5. **Base Classes Supported** ✅

The migration now correctly handles:
- `Ext` (basic extension)
- `ExtObj` (SkySpark 4.0 pattern, used by hxTask)
- `ConnExt` (connector extensions)

---

## Real hxTask Structure

```
hxTask/
  build.fan                  ← Build configuration
  pod.fandoc                 ← Documentation
  fan/
    TaskExt.fan             ← Extension class (extends ExtObj)
    TaskFuncs.fan           ← @Api functions (const class)
    Task.fan                ← Domain class
    Errs.fan                ← Error definitions
  lib/
    lib.trio                ← Library metadata (def:^lib format)
    defs.trio               ← Type definitions
    skyarc.trio             ← Additional specs
  test/
    TaskTest.fan            ← Unit tests
```

**build.fan:**
```fantom
index = ["xeto.bindings":"hx.task", "ph.lib": "task"]
```

**lib.trio:**
```trio
--------------------------------------------------------------------------
def: ^lib:task
depends: [^lib:ph, ^lib:obs, ^lib:axon, ^lib:hx, ^lib:skyarc]
typeName:"hxTask::TaskExt"
doc: "Async task engine"
--------------------------------------------------------------------------
```

---

## Migration Output Now Produces

For a project named `bassgMilesight` with prefix `akbin`:

### File Structure:
```
bassgMilesight/
  buildLocal.fan
  fan/
    BassgMilesightExt.fan
    BassgMilesightFuncs.fan
    <other .fan files>
  lib/
    lib.trio
    funcs.xeto (if @Api functions found)
    settings.xeto (if @Config fields found)
    lib.xeto
```

### buildLocal.fan:
```fantom
using build

class Build : BuildPod {
  new make() {
    podName = "bassgMilesight"
    version = Version("4.0.0")
    depends = [
      "sys 1.0",
      "hx 4.0"
    ]
    srcDirs = [`fan/`]
    resDirs = [`lib/`]
    index = ["xeto.bindings":"akbin.bassgmilesight", "ph.lib": "bassgmilesight"]
  }
}
```

### lib/lib.trio:
```trio
--------------------------------------------------------------------------
def: ^lib:akbin.bassgmilesight
depends: [^lib:ph, ^lib:hx]
typeName:"bassgMilesight::BassgMilesightExt"
doc: "Migrated to SkySpark 4.0"
--------------------------------------------------------------------------
```

---

## Summary of Corrections

| Aspect | Before | After |
|--------|--------|-------|
| **lib.trio format** | `dis:` with braces | `def: ^lib:` with refs |
| **lib.trio depends** | `{lib: "name"}` | `^lib:name` |
| **lib.trio typeName** | Missing | `typeName:"Pod::ExtClass"` |
| **build.fan index order** | ph.lib first | xeto.bindings first |
| **build.fan ph.lib** | Full qualified name | Short name only |
| **Library name case** | Mixed case | Lowercase |
| **File structure** | Single file | Split Ext + Funcs |
| **Base classes** | Only Ext | Ext, ExtObj, ConnExt |

---

## Verified Against

- ✅ `haxall/src/ext/hxTask` (SkySpark 4.0.3 source)
- ✅ Build succeeds with SkySpark 4.0.3 compiler
- ✅ Follows official SkyFoundry extension structure

All changes have been applied to `/src/migration/index.ts` and verified to compile successfully.
