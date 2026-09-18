# Haxall 4.0.4 Methods Workflow Documentation

Comprehensive methods and workflow patterns derived from analysis of the Haxall 4.0.4 codebase.

---

## Table of Contents

1. [Folio Database CRUD Operations](#1-folio-database-crud-operations)
2. [Connector Framework](#2-connector-framework)
3. [Axon Function Implementation](#3-axon-function-implementation)
4. [Extension Architecture](#4-extension-architecture)
5. [Observable/Observer Pattern](#5-observableobserver-pattern)
6. [Stream Processing](#6-stream-processing)

---

## 1. Folio Database CRUD Operations

### 1.1 Read Operations

#### Read by ID
```fantom
// Single record lookup
Dict? readById(Ref? id, Bool checked := true)
{
  checkRead.doReadById(id ?: Ref.nullRef, checked)
}

// Usage
rec := folio.readById(@site-123)
rec := folio.readById(@site-123, false)  // Returns null if not found
```

#### Read by Filter
```fantom
// Single record by filter
Dict? read(Filter filter, Bool checked := true)

// Multiple records by filter
Dict[] readAll(Filter filter, Dict? opts := null)

// Count records
Int readCount(Filter filter)

// Iterate with callback
Obj? readAllEachWhile(Filter filter, Dict? opts, |Dict rec->Obj?| f)
```

#### Filter Examples
```fantom
// Simple tag existence
verifyQuery("num", [a, b, c])

// Comparison operators
verifyQuery("num > 4", [e, f, g])
verifyQuery("num == 4", [d])

// Reference navigation
verifyQuery("fooRef->num==1", [b, c, d])

// Boolean operators
verifyQuery("num and fooRef", [b, c, d, e, f])
verifyQuery("fooRef or bar", [b, c, d, e, f])

// Negation
verifyQuery("not fooBar", [a, b, c, d, e, f, g])
```

### 1.2 Create Operations

#### Using Diff for Add
```fantom
// Create Diff for adding new record
new makeAdd(Obj? changes, Ref id := Ref.gen)
{
  this.id = id
  this.changes = Etc.makeDict(changes)
  this.flags = add

  if (this.changes.has("id"))
    throw DiffErr("makeAdd cannot specify 'id' tag")
}

// Usage
Dict addRec(Obj tags)
{
  dict := Etc.makeDict(tags)
  id := dict["id"] ?: Ref.gen
  if (dict["id"] != null)
    dict = Etc.dictRemove(dict, "id")
  return doCommit(Diff.makeAdd(dict, id))
}
```

### 1.3 Update Operations

#### Using Diff for Modify
```fantom
// Create Diff for modifying existing record
new make(Dict? oldRec, Obj? changes, Int flags := 0)
{
  this.changes = Etc.makeDict(changes)
  this.flags = flags
  if (oldRec == null)
  {
    if (flags.and(add) == 0) throw DiffErr("Must pass 'add' flag")
    this.id = Ref.gen
  }
  else
  {
    this.id = oldRec->id
    this.oldMod = oldRec->mod
  }
}

// Usage - persistent change
a = verifyCommit(a, ["foo":"bar"], 0, ["dis":"A", "foo":"bar"], [:])

// Usage - transient change
a = verifyCommit(a, ["curVal":n(75)], Diff.transient,
      ["dis":"A"], ["curVal":n(75)])
```

#### Removing Tags
```fantom
// Use Remove.val to remove a tag
a = verifyCommit(a, ["foo":Remove.val, "newP":m], 0, ...)
```

### 1.4 Delete Operations

#### Using Diff for Remove
```fantom
// Flag bitmask
static const Int remove := 0x02

// Create remove diff
Diff(rec, null, Diff.remove.or(Diff.force))

// Trash pattern (soft delete)
commit(b, ["trash":m])  // Mark as trash
commit(c, ["trash":Remove.val])  // Restore from trash
```

### 1.5 Diff Flags

| Flag | Value | Purpose |
|------|-------|---------|
| `add` | 0x01 | Adding new record |
| `remove` | 0x02 | Removing record |
| `transient` | 0x04 | Not persisted to disk |
| `force` | 0x08 | Bypass concurrency check |
| `bypassRestricted` | 0x10 | System-level records |
| `curVal` | 0x20 | Has curVal/curStatus |
| `point` | 0x40 | Adding new point |
| `treeUpdate` | 0x80 | Modifying tree structure |

### 1.6 Commit Lifecycle

```
Diff Input
    ↓
FolioUtil.checkDiffs()  [Validation]
    ↓
Commit.verify()         [Pre-conditions]
    ↓
folio.hooks.preCommit() [Hooks]
    ↓
Commit.apply()          [Apply changes]
    ↓
folio.hooks.postCommit() [Hooks]
    ↓
Diff Output (with newRec, newMod)
```

### 1.7 Concurrent Change Detection

```fantom
// Verify phase checks mod timestamp
if (!inDiff.isForce && oldRec.dict->mod != oldMod)
  throw ConcurrentChangeErr("$id: ${oldRec.dict->mod} != $oldMod")

// Force flag bypasses check
diff := Diff(rec, ["foo":"bar"], Diff.force)
folio.commit(diff)  // Always succeeds
```

### 1.8 Tag Rules

| Category | Tags | Behavior |
|----------|------|----------|
| Never | `id`, `mod`, `transient` | Cannot be set |
| Restricted | `projMeta`, `uiMeta`, `ext` | System-level only |
| Persistent Only | `conn`, `dis`, `site`, `point`, `trash` | Cannot be transient |
| Transient Only | `connState`, `curVal`, `curStatus`, `writeVal` | Cannot be persistent |

---

## 2. Connector Framework

### 2.1 Architecture Overview

```
ConnFwExt
├── ConnService       (Global connector registry)
├── ConnRoster        (Manages conns & points)
├── ConnTuningRoster  (Manages tuning configs)
└── ConnPoller        (Manages polling schedules)
         ↓
ConnExt (Protocol-Specific)
├── ModbusExt, EcobeeExt, SqlExt, MqttExt, etc.
         ↓
Conn (Actor Per Connection)
├── ConnMgr (Message router & state manager)
├── ConnVars (Mutable state: status, errors)
├── ConnConfig (Configuration from rec)
└── ConnCommitter (Transient tag updates)
         ↓
ConnDispatch (Abstract Callbacks)
├── onOpen(), onClose(), onPing()
├── onSyncCur(), onWatch(), onWrite()
├── onSyncHis(), onLearn()
└── onHouseKeeping()
```

### 2.2 Implementing ConnDispatch

```fantom
class EcobeeDispatch : ConnDispatch
{
  new make(Obj arg) : super(arg) {}

  override Void onOpen()
  {
    // Establish connection
    client := EcobeeClient(apiKey, refreshToken)
    client.connect
    this.clientRef.val = client
  }

  override Void onClose()
  {
    client?.close
    this.clientRef.val = null
  }

  override Void onPing()
  {
    client.ping
  }

  override Dict onSyncCur(ConnPoint[] points)
  {
    points.each |pt|
    {
      try
      {
        val := client.readPoint(pt.address)
        pt.updateCurOk(val)
      }
      catch (Err e)
      {
        pt.updateCurErr(e)
      }
    }
    return Etc.dict0
  }

  override Void onWrite(ConnPoint pt, ConnWriteInfo info)
  {
    try
    {
      client.writePoint(pt.address, info.val)
      pt.updateWriteOk(info)
    }
    catch (Err e)
    {
      pt.updateWriteErr(info, e)
    }
  }

  override Grid onLearn(Obj? arg)
  {
    EcobeeLearn(this, arg).learn
  }
}
```

### 2.3 Connector State Machine

```
     CLOSED ────→ OPENING ───→ OPEN ────→ CLOSING
        ^                       │           │
        └───────────────────────┴───────────┘

States:
  - closed:  Not connected
  - opening: Establishing connection
  - open:    Ready for operations
  - closing: Tearing down
```

### 2.4 Point State Updates

```fantom
// Current value sync
pt.updateCurOk(val)           // Success with value
pt.updateCurErr(err)          // Error
pt.updateCurStale             // Data too old

// Write operations
pt.updateWriteReceived(info)  // Write received
pt.updateWriteOk(info)        // Write succeeded
pt.updateWriteErr(info, err)  // Write failed
pt.updateWritePending(true)   // Pending due to throttle

// History sync
pt.updateHisOk(items, span)   // History synced
pt.updateHisErr(err)          // History sync failed
```

### 2.5 Tuning Configuration

```fantom
ConnTuning
├── pollTime       // Frequency between polls (default: 10sec)
├── staleTime      // Time before stale (default: 5min)
├── writeMinTime   // Minimum time between writes
├── writeMaxTime   // Maximum time (periodic rewrite)
├── writeOnOpen    // Rewrite on connection open
└── writeOnStart   // Issue write on startup

// Hierarchy: Library → Connector → Point
Duration pollFreqEffective()
{
  if (pt.tuning != null) return pt.tuning.pollTime
  if (conn.tuning != null) return conn.tuning.pollTime
  return ext.tuning.pollTime
}
```

### 2.6 Learn/Discover Pattern

```fantom
// Learn returns Grid with discoverable points
virtual Grid onLearn(Obj? arg)
{
  throw UnsupportedErr()
}

// Grid columns:
// dis      - Display name (required)
// point    - Marker for mappable point
// {proto}Cur   - Address for current value
// {proto}Write - Address for writing
// {proto}His   - Address for history
// kind     - Point kind (Number, Bool, Str)
// unit     - Point unit
// learn    - Opaque arg for navigation

// Navigation:
// onLearn(null)        -> Root elements
// onLearn(elem.learn)  -> Children of element
```

---

## 3. Axon Function Implementation

### 3.1 Function Registration

```fantom
// Basic registration
@Api @Axon static Obj? myFunc(Str input)
{
  return input.upper
}

// Admin-only function
@Api @Axon { admin = true }
static Obj? commit(Obj diffs) { }

// With metadata (for fold functions)
@Api @Axon { meta = ["foldOn":"Number"] }
static Obj? sum(Obj? val, Obj? acc) { }

// Superuser-only
@NoDoc @Api @Axon { su = true }
static Str threadDump() { }
```

### 3.2 Parameter Patterns

```fantom
// Simple parameters
@Api @Axon static Obj? isEmpty(Obj? val)

// Optional parameters with defaults
@Api @Axon static Obj? col(Grid grid, Str name, Bool checked := true)

// Expression parameters (lazy evaluation)
@Api @Axon static Dict? read(Expr filterExpr, Expr checked := Literal.trueVal)
{
  cx := curContext
  filter := filterExpr.evalToFilter(cx)  // Explicit evaluation
  check := checked.eval(cx)
  return cx.db.read(filter, check)
}

// Function/closure parameters
@Api @Axon static Obj? each(Obj val, Fn fn)
{
  if (val is Grid) { ((Grid)val).each(toGridIterator(fn)); return null }
  // ...
}
```

### 3.3 Context Access

```fantom
// Option 1: Direct property
@Api @Axon
static Obj readById(Ref? id, Bool checked := true)
{
  curContext.db.readById(id ?: Ref.nullRef, checked)
}

// Option 2: Local variable
@Api @Axon
static Dict? read(Expr filterExpr, Expr checked := Literal.trueVal)
{
  cx := curContext
  filter := filterExpr.evalToFilter(cx)
  return cx.db.read(filter, check)
}

// Option 3: For expression callbacks
private static Func toGridIterator(Fn fn)
{
  cx := AxonContext.curAxon
  args := [null, null]
  return |Obj? row, Int i->Obj?|
  {
    fn.call(cx, args.set(0, row).set(1, Number.makeInt(i)))
  }
}
```

### 3.4 Return Patterns

```fantom
// Scalar returns
@Api @Axon static Number readCount(Expr filterExpr)
{
  cx := curContext
  filter := filterExpr.evalToFilter(cx)
  return Number(cx.db.readCount(filter))
}

// Grid returns
@Api @Axon static Grid readAll(Expr filterExpr, Expr? optsExpr := null)
{
  cx := curContext
  filter := filterExpr.evalToFilter(cx)
  opts := optsExpr == null ? Etc.dict0 : (Dict?)optsExpr.eval(cx)
  return cx.db.readAll(filter, opts)
}

// Stream returns (async/lazy)
@Api @Axon static Obj readAllStream(Expr filterExpr)
{
  cx := curContext
  filter := filterExpr.evalToFilter(cx)
  return ReadAllStream(filter)
}
```

### 3.5 Input Validation

```fantom
// Type checking with dispatch
@Api @Axon static Obj? isEmpty(Obj? val)
{
  if (val is Dict) return ((Dict)val).isEmpty
  return val->isEmpty  // Dynamic dispatch
}

// Multi-type handling
@Api @Axon static Obj? get(Obj? val, Obj? key)
{
  if (val is Dict) return ((Dict)val).get(key)
  if (key is ObjRange) return val->getRange(((ObjRange)key).toIntRange)
  if (val is Str) return Number.makeInt(((Str)val).get(((Number)key).toInt))
  if (key is Number) key = ((Number)key).toInt
  return val->get(key)
}

// Error helper
internal static Err argErr(Str name, Obj? val)
{
  t := val == null ? "null" : val.typeof.qname
  return ArgErr("Invalid arg '$t' to 'core::$name'")
}
```

### 3.6 Fold Function Pattern

```fantom
// Three-phase fold lifecycle
@Api @Axon { meta = ["foldOn":"Number"] }
static Obj? sum(Obj? val, Obj? acc)
{
  // Phase 1: Initialize
  if (val === foldStartVal) return Fold.createAxon("sum")

  // Phase 3: Finalize
  fold := (Fold)acc
  if (val === foldEndVal) return fold.finish

  // Phase 2: Accumulate
  if (val != null) fold.add(val)
  return fold
}

// Fold invocation
@Api @Axon static Obj? fold(Obj? val, Fn fn)
{
  list := val as List ?: throw argErr("fold", val)
  cx := AxonContext.curAxon
  args := Obj?[foldStartVal, null]

  // Initialize
  r := fn.call(cx, args)

  // Iterate
  list.eachWhile |item|
  {
    r = fn.call(cx, args.set(0, item).set(1, r))
    return r === NA.val ? r : null
  }

  // Finalize
  return fn.call(cx, args.set(0, foldEndVal).set(1, r))
}
```

---

## 4. Extension Architecture

### 4.1 Extension Interface

```fantom
const mixin Ext
{
  @NoDoc abstract ExtSpi spi()

  virtual Runtime rt() { spi.rt }
  virtual Sys sys() { spi.sys }
  virtual Proj? proj() { spi.proj(true) }
  virtual Dict settings() { spi.settings }
  virtual Log log() { spi.log }
}

@NoDoc const mixin ExtSpi
{
  abstract Runtime rt()
  abstract Sys sys()
  abstract Proj? proj(Bool checked)
  abstract Str name()
  abstract Spec spec()
  abstract Dict settings()
  abstract Log log()
  abstract Bool isRunning()
  abstract Future send(Obj? msg)
  abstract Actor actor()
}
```

### 4.2 Extension Lifecycle

```fantom
const mixin Ext
{
  // Startup lifecycle
  virtual Void onStart() {}      // Library started
  virtual Void onReady() {}      // All libs fully started
  virtual Void onSteadyState() {} // Reached steady state

  // Shutdown lifecycle
  virtual Void onUnready() {}    // Before stop
  virtual Void onStop() {}       // Extension stopped

  // Configuration
  virtual Void onSettings() {}   // Settings modified

  // Periodic maintenance
  virtual Void onHouseKeeping() {}
  virtual Duration? houseKeepingFreq() { null }

  // System events
  virtual Void onSysReload() {}

  // Non-standard messages
  virtual Obj? onReceive(HxMsg msg)
  {
    throw UnsupportedErr("Unknown msg: $msg")
  }
}
```

### 4.3 Extension Factory

```fantom
static ExtObj? instantiate(HxBoot? boot, HxExts exts, Lib lib)
{
  // Lookup spec from Xeto namespace
  ref := lib.meta["libExt"] as Ref
  spec := exts.rt.ns.spec(ref.id, false)

  // Extract Fantom type binding
  type := spec.fantomType

  // Read extension settings
  settings := exts.rt.settingsMgr.extRead(name)

  // Create initialization context
  init := HxExtSpiInit
  {
    it.boot = boot
    it.rt = exts.rt
    it.name = name
    it.spec = spec
    it.type = type
    it.settings = settings
    it.actorPool = exts.actorPool
  }

  // Instantiate via reflection
  spi := exts.makeSpi(init)
  ctor := type.method("make")

  Actor.locals["hx.spi"] = spi
  try
    ext = ctor.callList(ctorArgs)
  finally
    Actor.locals.remove("hx.spi")

  spi.extRef.val = ext
  return ext
}
```

### 4.4 Service Interfaces

```fantom
// File service
const mixin IFileExt : SysExt
{
  abstract File resolve(Uri uri)
}

// User service
const mixin IUserExt : SysExt
{
  abstract User? read(Obj username, Bool checked := true)
  abstract UserSession? authenticate(WebReq req, WebRes res, Dict? opts)
  abstract Void closeSession(UserSession session)
}

// History service
const mixin IHisExt : Ext
{
  abstract Void read(Dict pt, Span? span, Dict? opts, |HisItem| f)
  abstract Future write(Dict pt, HisItem[] items, Dict? opts)
}

// Point service
const mixin IPointExt : Ext
{
  abstract Future pointWrite(Dict point, Obj? val, Int level, Obj who, Dict? opts)
  abstract Grid pointArray(Dict point)
}

// Task service
const mixin ITaskExt : Ext
{
  abstract HxTask? cur(Bool checked := true)
  abstract Future run(Expr expr, Obj? msg := null)
  abstract Void progress(Dict progress)
}
```

---

## 5. Observable/Observer Pattern

### 5.1 Observable Base

```fantom
abstract const class Observable
{
  Str name()

  Bool hasSubscriptions() { !subscriptions.isEmpty }
  Subscription[] subscriptions() { subscriptionsRef.val }
  private const AtomicRef subscriptionsRef := AtomicRef(Subscription#.emptyList)

  Subscription subscribe(Observer observer, Dict config)
  {
    s := onSubscribe(observer, config)
    while (true)
    {
      oldList := subscriptions
      newList := oldList.dup.add(s).toImmutable
      if (subscriptionsRef.compareAndSet(oldList, newList)) break
    }
    s.activeRef.val = true
    return s
  }

  Void unsubscribe(Subscription s)
  {
    while (true)
    {
      oldList := subscriptions
      i := oldList.indexSame(s)
      newList := oldList.dup
      newList.removeAt(i)
      newList = newList.toImmutable
      if (subscriptionsRef.compareAndSet(oldList, newList)) break
    }
    s.activeRef.val = false
    onUnsubscribe(s)
  }
}
```

### 5.2 Observer Interface

```fantom
const mixin Observer
{
  abstract Dict meta()
  abstract Actor actor()

  @NoDoc virtual Obj toActorMsg(Observation obs) { obs }
  @NoDoc virtual Obj? toSyncMsg() { null }
}
```

### 5.3 Built-in Observables

```fantom
const class HxObservables : Actor, RuntimeObservables
{
  new make(HxRuntime rt) : super(rt.actorPool)
  {
    schedule = ScheduleObservable()   // Periodic events
    commits = CommitsObservable(rt)   // Database changes
    watches = WatchesObservable(rt)   // Watch changes
    curVals = CurValsObservable()     // Current value changes
    hisWrites = HisWritesObservable() // History writes
  }
}
```

### 5.4 Subscribing to Events

```fantom
// Subscribe to commits
ext.observe("obsCommits",
  Etc.makeDict([
    "obsAdds": Marker.val,
    "obsUpdates": Marker.val,
    "obsRemoves": Marker.val,
    "syncable": Marker.val,
    "obsFilter": "point"
  ]), MyExt#onPointEvent)

// Subscribe to schedules
ext.observe("obsSchedule",
  Etc.makeDict([
    "obsScheduleFreq": "1min"
  ]), MyExt#onSchedule)
```

---

## 6. Stream Processing

### 6.1 Source Stream

```fantom
@Js
internal class ReadAllStream : SourceStream
{
  new make(Filter filter) { this.filter = filter }

  override Str funcName() { "readAllStream" }
  override Obj?[] funcArgs() { [filter] }

  override Void onStart(Signal sig)
  {
    cx := (Context)this.cx
    cx.db.readAllEachWhile(filter, Etc.dict0) |rec->Obj?|
    {
      submit(rec)  // Non-blocking submission
      return isComplete ? "break" : null
    }
  }

  const Filter filter
}
```

### 6.2 Transform Stream

```fantom
@Js
internal class MapStream : TransformStream
{
  new make(MStream prev, Fn fn) : super(prev) { this.fn = fn }

  override Str funcName() { "map" }

  override Void onData(Obj? data)
  {
    cx := AxonContext.curAxon
    result := fn.call(cx, [data, null])
    submit(result)
  }

  private const Fn fn
}
```

### 6.3 Terminal Stream

```fantom
@Js
internal class CommitStream : TerminalStream
{
  new make(MStream prev) : super(prev) {}

  override Str funcName() { "commit" }

  override Void onData(Obj? data)
  {
    if (data == null) return

    // Back pressure handling
    cx := (Context)this.cx
    count++
    if (count % 100 == 0) cx.db.sync

    // Async commit
    diff := data as Diff
    cx.db.commitAsync(diff)
  }

  override Obj? onRun()
  {
    cx := (Context)this.cx
    cx.db.sync  // Wait for completion
    return Number(count)
  }

  private Int count
}
```

### 6.4 Stream Signal Flow

```
Signal.start
    ↓
SourceStream.onStart()
    ↓ submit(data)
TransformStream.onData()
    ↓ submit(transformed)
TerminalStream.onData()
    ↓
Signal.complete
    ↓
TerminalStream.onRun() → Result
```

---

## Summary

| Component | Key Method | Purpose |
|-----------|------------|---------|
| **Folio** | `commit(Diff)` | CRUD operations |
| **Folio** | `readAll(Filter)` | Query records |
| **Connector** | `onOpen/onClose` | Connection lifecycle |
| **Connector** | `onSyncCur` | Current value sync |
| **Connector** | `onWrite` | Write operations |
| **Axon** | `@Axon static` | Function registration |
| **Extension** | `onStart/onStop` | Extension lifecycle |
| **Observable** | `subscribe` | Event subscription |
| **Stream** | `submit(data)` | Async data flow |

---

*Generated from Haxall 4.0.4 source code analysis*
