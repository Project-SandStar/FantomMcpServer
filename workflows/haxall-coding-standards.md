# Haxall 4.0.4 Coding Standards

Comprehensive coding standards derived from analysis of 913 Fantom source files in the Haxall 4.0.4 codebase.

---

## Table of Contents

1. [Naming Conventions](#1-naming-conventions)
2. [Type System Usage](#2-type-system-usage)
3. [Error Handling](#3-error-handling)
4. [Async & Concurrency Patterns](#4-async--concurrency-patterns)
5. [Immutability & Thread Safety](#5-immutability--thread-safety)
6. [Code Organization](#6-code-organization)
7. [Code Metrics & Size Guidelines](#7-code-metrics--size-guidelines)
8. [Documentation Standards](#8-documentation-standards)

---

## 1. Naming Conventions

### 1.1 Class Naming

**Pattern**: PascalCase

| Type | Convention | Examples |
|------|------------|----------|
| Base Classes | Simple descriptive names | `Folio`, `Context`, `Signal` |
| Manager Classes | `-Mgr` suffix | `HxFolioMgr`, `StoreMgr`, `IndexMgr` |
| Extension Classes | `-Ext` suffix | `HxdFileExt`, `EcobeeExt` |
| Error Classes | `-Err` suffix | `AxonErr`, `SyntaxErr`, `EvalErr` |
| Library Classes | `-Lib` suffix | `DefLib`, `MLib`, `DocLib` |
| Web Handlers | `-Web` suffix | `ExtWeb`, `HxShellWeb`, `ApiWeb` |
| Utility Classes | `-Util` suffix | `FolioUtil`, `HxUtil`, `AuthUtil` |
| SPI Implementations | `-Spi` suffix | `MCompSpi`, `HxExtSpi`, `PlatformSpi` |

**Modifiers**:
```fantom
const class Signal { }              // Immutable class
abstract const class Folio { }      // Abstract immutable base
internal const class HxdFile { }    // Package-private
const mixin Ext { }                 // Interface-like mixin
```

### 1.2 Method Naming

**Pattern**: camelCase

| Prefix | Purpose | Examples |
|--------|---------|----------|
| `make` | Constructor methods | `make()`, `makeAdd()`, `makeCoalescing()` |
| `do` | Internal implementation | `doResolveTop()`, `doSet()`, `doCall()` |
| `on` | Event handlers/callbacks | `onData()`, `onStart()`, `onComplete()` |
| `is` | Boolean queries | `isSource()`, `isEmpty()`, `isComplete()` |
| `has` | Containment queries | `has()`, `hasDef`, `hasDepends()` |
| `get` | Accessors | `get()`, `getOld()`, `getSafe()` |
| `to` | Conversion methods | `toStr()`, `toDict()`, `toGrid()` |
| `read/write` | I/O operations | `read()`, `write()`, `readAllStr()` |

### 1.3 Variable Naming

**Pattern**: camelCase

```fantom
// Local variables
stream, stack, frame, oldRec, newRec

// Loop counters
i, x, f, n

// Abbreviations
acc (accumulator), spec, meta, rec, col, row

// AtomicRef fields (postfix with Ref)
rtRef, sysRef, projRef, configRef, stashRef
```

### 1.4 Constant Naming

**Pattern**: camelCase (NOT UPPERCASE)

```fantom
static const Signal start    := Signal(SignalType.start)
static const Int maxRecIdSize := 60
static const Duration ecobeePollInterval := 3min

// Flag constants
static const Int add := 0x01
static const Int remove := 0x02
static const Int transient := 0x04
```

### 1.5 Pod/Package Naming

**Pattern**: lowercase with `hx` prefix for Haxall extensions

```
Core: hx, axon, folio, haystack, xeto, auth, def, obs
Extensions: hxUtil, hxFolio, hxStore, hxConn, hxPoint
Connectors: hxEcobee, hxMqtt, hxModbus, hxObix, hxSql
```

### 1.6 File Naming

**Pattern**: PascalCase matching class name

```
Signal.fan          // Contains class Signal
CircularBuf.fan     // Contains class CircularBuf
Errs.fan            // Contains multiple error classes
MiscTest.fan        // Test class MiscTest
```

### 1.7 Test Naming

```fantom
// Test class: <Name>Test
class MiscTest : Test
class StoreMgrTest : HaystackTest

// Test methods: test<Scenario>
Void testCircularBuf() { }
Void testRecs() { }

// Helper methods: verify<Condition>
Void verifyCircularBuf(CircularBuf c, Obj?[] expected) { }
```

---

## 2. Type System Usage

### 2.1 Classes & Inheritance

```fantom
// Abstract immutable error class
@Js
const abstract class AxonErr : Err
{
  new make(Str? msg, Loc loc, Err? cause := null) : super(msg, cause)
  {
    this.loc = loc
  }
  const Loc loc
}

// Concrete const subclass
@Js
const class SyntaxErr : AxonErr
{
  new make(Str? msg, Loc loc, Err? cause := null) : super(msg, loc, cause) {}
}
```

### 2.2 Mixins

```fantom
// Mixin with operator overloading
@Js
mixin Comp
{
  abstract CompDef def()

  @Operator abstract Obj? get(Str name)
  @Operator abstract This set(Str name, Obj? val)

  abstract This recompute(AxonContext cx)
}

// Mixin inheritance
@Js
mixin HaystackContext : XetoContext
{
  @NoDoc static HaystackContext nil() { nilRef }
  private static const NilContext nilRef := NilContext()
}
```

### 2.3 Enums

```fantom
@NoDoc @Js
enum class Token
{
  id("identifier"),
  typename("typename"),
  colon(":"),
  eof("eof");

  private new make(Str? symbol := null)
  {
    this.symbol = symbol ?: name[0..-8]
    this.keyword = symbol == null
  }

  // Static initialization for lookup
  const static Str:Token keywords
  static
  {
    map := Str:Token[:]
    vals.each |tok| { if (tok.keyword) map[tok.symbol] = tok }
    keywords = map
  }

  const Str symbol
  const Bool keyword
}
```

### 2.4 Null Safety

```fantom
// Nullable types use ? suffix
Str? libNameErr(Str n)
{
  if (n.isEmpty) return "Lib name cannot be empty"
  if (!n[0].isLower) return "Must start with lowercase"
  return null  // null indicates success
}

// Safe access patterns
val := args.getSafe(i)                    // Returns null if not found
result := obj != null ? obj : defaultVal  // Ternary
meta.get("search") as Str ?: ""           // Null coalescing
```

### 2.5 Type Annotations

```fantom
// Explicit types
Str:Obj? vars := Str:Obj?[:]
CallFrame[] stack := [,]

// Generic collections
Obj?[] items := [,]
[Int:Bool] map := [:]

// Function types
|Obj? msg->Obj?| toCoalesceKey
```

---

## 3. Error Handling

### 3.1 Exception Hierarchy

```
Err (base)
├── AxonErr (abstract, with location)
│   ├── SyntaxErr
│   ├── EvalErr
│   │   ├── EvalTimeoutErr
│   │   └── ThrowErr
│   └── InvalidOverrideErr
├── FolioErr
│   ├── InvalidRecIdErr
│   ├── InvalidTagNameErr
│   ├── CommitErr
│   │   └── ConcurrentChangeErr
│   └── RecErr
│       ├── HisConfigErr
│       └── HisWriteErr
├── ConnErr
│   ├── RemoteStatusErr
│   └── UnknownConnErr
└── Protocol-specific (MqttErr, FtpErr, OAuthErr)
```

### 3.2 Exception Construction Patterns

```fantom
// Standard with cause chain
const class ValidateErr : Err
{
  new make(Str msg, Err? cause := null) : super(msg, cause) {}
}

// With location information
const class EvalErr : AxonErr
{
  new make(Str? msg, AxonContext cx, Loc loc, Err? cause := null)
    : super(msg, loc, cause)
  {
    axonTrace = cx.traceToStr(loc)
  }
  const Str axonTrace
}

// With context information
const class RecErr : Err
{
  new make(Dict rec, Str msg, Err? cause := null)
    : super(toRecMsg(rec, msg), cause)
  {
    this.rec = rec
  }
  const Dict rec
}
```

### 3.3 Try-Catch Patterns

```fantom
// Simple with specific error types
try
{
  if (!expr.isEmpty) run(expr)
}
catch (SyntaxErr e) { err("Syntax Error: $e.msg") }
catch (EvalErr e) { err(e.msg, e.cause) }
catch (Err e) { err(e.toStr, e) }

// Try-catch-finally for resources
Uri delete(Uri uri)
{
  try
  {
    path := toFilePath(uri)
    res := open(uri, "DELE $path")
    return path.toUri
  }
  finally close
}

// Conditional re-throw
catch (ShutdownErr e) {}  // Expected, ignore
catch (Err e)
{
  if (conn.isAlive) log.err("Conn.updateConnState", e)
}
```

### 3.4 Checked Parameter Pattern

```fantom
static TimeZone? hisTz(Dict rec, Bool checked := true)
{
  val := rec["tz"]
  if (val == null)
  {
    if (checked) throw HisConfigErr(rec, "Missing 'tz' tag")
    return null
  }
  // ...
}
```

---

## 4. Async & Concurrency Patterns

### 4.1 Actor Model

```fantom
const class HxExtSpi : Actor, ExtSpi
{
  new make(HxExtSpiInit init) : super(init.actorPool)
  {
    this.rt = init.rt
    this.settingsRef = AtomicRef(typedRec(init.settings))
  }

  override Obj? receive(Obj? msgObj)
  {
    msg := msgObj as HxMsg ?: throw ArgErr("Invalid msg")
    try
    {
      if (msg.id === "settings") return onSettings
      if (msg.id === "start") return onStart
      if (msg.id === "stop") return onStop
    }
    catch (Err e) { log.err("Ext callback", e) }
  }
}
```

### 4.2 Message Passing

```fantom
// Message class
const class HxMsg
{
  new make(Str id, Obj? a := null, Obj? b := null, Obj? c := null)
  {
    this.id = id; this.a = a; this.b = b; this.c = c
  }
  const Str id
  const Obj? a, b, c
}

// Usage
actor.send(HxMsg("ping"))
actor.send(HxMsg("write", point, info))
result := actor.send(HxMsg("sync")).get(timeout)
```

### 4.3 AtomicRef for Thread Safety

```fantom
private const AtomicRef timeoutRef := AtomicRef(30sec)

Duration timeout
{
  get { timeoutRef.val }
  set { timeoutRef.val = it }
}

// Compare-and-set for lock-free updates
while (true)
{
  oldList := subscriptions
  newList := oldList.dup.add(s).toImmutable
  if (subscriptionsRef.compareAndSet(oldList, newList)) break
}
```

### 4.4 Future Handling

```fantom
// Domain-specific future
const class FolioFuture : Future
{
  Duration timeout
  {
    get { timeoutRef.val }
    set { timeoutRef.val = it }
  }
  private const AtomicRef timeoutRef := AtomicRef(30sec)

  @NoDoc FolioRes getRes(Duration? timeout := null)
  {
    wraps.get(timeout ?: this.timeout)
  }

  Dict? dict(Bool checked := true)
  {
    rd := getRes
    dict := rd.dicts.getSafe(0)
    if (dict != null) return dict
    if (checked) throw UnknownRecErr(rd.errMsg)
    return null
  }
}
```

### 4.5 Message Coalescing

```fantom
// Actor with coalescing
internal new make(ConnExt ext, Dict rec)
  : super.makeCoalescing(ext.connActorPool, toCoalesceKey, toCoalesce)
{
}

private const static |HxMsg msg->Obj?| toCoalesceKey := |HxMsg msg->Obj?|
{
  if (msg.id === "write") return ((ConnPoint)msg.a).id
  if (msg.id === "poll") return msg.id
  return null
}

private const static |HxMsg a, HxMsg b->HxMsg| toCoalesce := |HxMsg a, HxMsg b->HxMsg|
{
  return b  // Last write wins
}
```

---

## 5. Immutability & Thread Safety

### 5.1 Const Classes

```fantom
// Completely immutable class
const class Signal
{
  new make(SignalType type, Err? err := null, Dict? meta := null)
  {
    this.type = type
    this.err = err
    this.meta = meta ?: Etc.dict0
  }
  const SignalType type
  const Err? err
  const Dict meta
}
```

### 5.2 toImmutable Pattern

```fantom
// Convert mutable to immutable
override Obj? onFinish() { list.toImmutable }

// Build immutable from mutable
acc := Str:Obj?[:] { ordered = true }
acc["type"] = type.encode
return Etc.makeDict(acc)  // Returns immutable Dict
```

### 5.3 Once Pattern for Lazy Init

```fantom
// Lazy initialization of immutable value
override once DateTime now() { DateTime.now(null) }

// Outer function reference
@NoDoc Fn? outer() { outerRef.val }
internal const AtomicRef outerRef := AtomicRef(null)
```

---

## 6. Code Organization

### 6.1 Pod Structure

```
podName/
  fan/                 # Source files
    *.fan             # Organized by feature
    subfolder/        # Optional grouping
  test/                # Test files
    *Test.fan
  build.fan            # Build script
```

### 6.2 File Organization

```fantom
// 1. Copyright header
//
// Copyright (c) 2024, SkyFoundry LLC
// Licensed under the Academic Free License version 3.0
//

// 2. Imports
using concurrent
using haystack

// 3. Class documentation
**
** Description of class purpose
**
class MyClass
{
  //////////////////////////////////////////////////////////////////////////
  // Constructor
  //////////////////////////////////////////////////////////////////////////

  new make() { }

  //////////////////////////////////////////////////////////////////////////
  // Public API
  //////////////////////////////////////////////////////////////////////////

  Void publicMethod() { }

  //////////////////////////////////////////////////////////////////////////
  // Internal
  //////////////////////////////////////////////////////////////////////////

  private Void internalMethod() { }

  //////////////////////////////////////////////////////////////////////////
  // Fields
  //////////////////////////////////////////////////////////////////////////

  private const Str field
}
```

### 6.3 Import Statements

```fantom
// Group by purpose, specific imports
using concurrent
using util
using xeto
using haystack
using axon::Comp
```

---

## 7. Code Metrics & Size Guidelines

*Derived from statistical analysis of 913 Fantom source files (172,439 total lines)*

### 7.1 Line Length

| Metric | Value |
|--------|-------|
| Average (all lines) | **26 characters** |
| Average (non-empty) | **31 characters** |
| Maximum observed | 256 characters |

**Distribution:**

| Range | Percentage | Guideline |
|-------|------------|-----------|
| ≤40 chars | 73.6% | **Target range** - most code |
| 41-60 chars | 15.0% | Acceptable |
| 61-80 chars | 9.4% | Use sparingly |
| 81-100 chars | 1.5% | Avoid |
| >100 chars | 0.5% | Exceptional only |

**Recommendations:**
- Keep lines under **60 characters** for readability
- Hard limit at **80 characters** for most code
- Break long method chains and conditionals across lines
- Use intermediate variables for complex expressions

### 7.2 File Length

| Metric | Value |
|--------|-------|
| Average | **189 lines** |
| Median | **112 lines** |
| Minimum | 9 lines |
| Maximum | 3,140 lines |

**Distribution:**

| Range | Percentage | Guideline |
|-------|------------|-----------|
| 1-50 lines | 23.4% | Small utilities, enums |
| 51-100 lines | 21.6% | Simple classes |
| 101-200 lines | 25.4% | **Target range** - typical class |
| 201-300 lines | 12.4% | Complex classes |
| 301-500 lines | 9.3% | Consider splitting |
| >500 lines | 7.9% | Refactor candidate |

**Recommendations:**
- Target **100-200 lines** per file
- Files over **300 lines** should be reviewed for splitting
- One primary class per file (with supporting private classes allowed)
- Extract large inner classes to separate files

### 7.3 Method Length Guidelines

Based on codebase patterns:
- **Simple methods**: 1-5 lines (getters, setters, delegators)
- **Standard methods**: 10-30 lines
- **Complex methods**: 30-50 lines (with clear section comments)
- **Maximum**: ~100 lines (rare, well-documented cases only)

### 7.4 Code Density

```fantom
// GOOD: Sparse, readable code
Void process(Dict rec)
{
  id := rec.id
  name := rec["name"] as Str ?: "unknown"

  if (name.isEmpty)
    throw ArgErr("Name required")

  doProcess(id, name)
}

// AVOID: Dense, hard to scan
Void process(Dict rec) { doProcess(rec.id, rec["name"] as Str ?: throw ArgErr("Name required")) }
```

### 7.5 Summary Targets

| Metric | Target | Hard Limit |
|--------|--------|------------|
| Line length | ≤60 chars | 80 chars |
| File length | 100-200 lines | 500 lines |
| Method length | 10-30 lines | 100 lines |
| Nesting depth | ≤3 levels | 5 levels |

---

## 8. Documentation Standards

### 8.1 Documentation Comments

```fantom
**
** CircularBuf provides a list of items with a fixed size.
** Once the fixed size is reached, newer elements replace
** the oldest items.
**
@Js
class CircularBuf
{
  ** Newest item added to the buffer
  Obj? newest() { tail < 0 ? null : items.getSafe(tail) }

  ** Add item to buffer, replacing oldest if at capacity
  This add(Obj? item) { ... }
}
```

### 8.2 Facets/Annotations

| Facet | Purpose |
|-------|---------|
| `@NoDoc` | Hide from documentation |
| `@Js` | Mark for JavaScript compilation |
| `@Operator` | Operator overloading |
| `@Transient` | Exclude from serialization |
| `@Api` | Public API marker |
| `@Axon` | Axon function registration |

```fantom
@Js @NoDoc
const abstract class AxonErr : Err
{
  @NoDoc new make(...) { }
}

@Api @Axon { admin = true }
static Obj? commit(Obj diffs) { }
```

---

## Summary Reference

### Naming Patterns

| Item | Pattern | Example |
|------|---------|---------|
| Classes | PascalCase | `Folio`, `HxFolioMgr` |
| Methods | camelCase | `toStr()`, `onData()` |
| Variables | camelCase | `stream`, `oldRec` |
| Constants | camelCase | `maxRecIdSize` |
| Pods | lowercase/camelCase | `axon`, `hxUtil` |
| Files | PascalCase | `Signal.fan` |
| Tests | `<Name>Test` | `MiscTest` |
| AtomicRef | `<name>Ref` | `stashRef` |

### Size Guidelines

| Metric | Target | Hard Limit |
|--------|--------|------------|
| Line length | ≤60 chars | 80 chars |
| File length | 100-200 lines | 500 lines |
| Method length | 10-30 lines | 100 lines |
| Avg line (observed) | 26-31 chars | - |
| Avg file (observed) | 112-189 lines | - |

---

*Generated from Haxall 4.0.4 source code analysis (913 Fantom files, 172,439 lines)*
