# SkySpark 3.1.x Connector Development Workflow

This document provides a step-by-step workflow for developing custom connectors for SkySpark 3.1.x using the `connExt` framework.

## Overview

SkySpark 3.1.x uses the `connExt` package (not `hxConn` which is for Haxall/SkySpark 4.x). The connector framework automatically derives class names from the pod name, so naming conventions are critical.

## Pod Naming Convention

**Critical**: Pod name must end with `Ext` (e.g., `attuneAwsExt`)

The framework derives connector class names using:
```fantom
connType = pod.name()[0..-4] + "Conn"  // e.g., "attuneAwsExt" → "AttuneAwsConn"
```

## Project Structure

```
myConnectorExt/
├── build.fan              # Build configuration with index entries
├── fan/
│   ├── MyConnectorExt.fan     # Extension class (extends ConnImplExt)
│   ├── MyConnectorModel.fan   # Model class (extends ConnModel)
│   ├── MyConnectorConn.fan    # Connector class (extends Conn)
│   ├── MyConnectorLib.fan     # Axon functions library
│   ├── MyConnectorClient.fan  # HTTP/API client (optional)
│   └── MyConnectorLearn.fan   # Learn implementation (optional)
└── lib/
    ├── conn.trio              # Connector tag definitions
    └── point.trio             # Point tag definitions
```

**IMPORTANT**: Use separate `.trio` files (`conn.trio`, `point.trio`) instead of a single `lib.trio`. This is the pattern used by working connectors like Milesight and Green Button.

## Step-by-Step Workflow

### Step 1: Create build.fan

```fantom
#! /usr/bin/env fan

using build

class Build : BuildPod
{
  new make()
  {
    podName = "myConnectorExt"  // Must end with "Ext"
    summary = "My Custom Connector"
    version = Version("1.0.0")

    depends = [
      "sys 1.0",
      "concurrent 1.0",
      "inet 1.0",
      "web 1.0",
      "util 1.0",
      "connExt 3.0+",      // SkySpark 3.1.x connector framework
      "axon 3.0+",
      "folio 3.0+",
      "skyarcd 3.0+",
      "skyarc 3.0+",
      "haystack 3.0+"
    ]

    srcDirs = [`fan/`]
    resDirs = [`lib/`]

    // CRITICAL: Both index entries required for registration
    index = [
      "skyarc.ext": "myConnectorExt::MyConnectorExt",
      "skyarc.lib": "myConnectorExt::MyConnectorLib"
    ]
  }
}
```

### Step 2: Create Extension Class (MyConnectorExt.fan)

```fantom
using skyarcd::Ext
using skyarcd::ExtMeta
using skyarcd::Context
using connExt

@ExtMeta
{
  name    = "myConnector"           // Extension name (without "Ext")
  icon    = "debug"                 // Icon from SkySpark icon set
  icon24  = `fan://frescoRes/img/iconMissing24.png`
  icon72  = `fan://frescoRes/img/iconMissing72.png`
  depends = ["conn"]                // Must depend on "conn" extension
}
const class MyConnectorExt : ConnImplExt
{
  @NoDoc
  new make() : super(MyConnectorModel()) {}

  override Void onStart()
  {
    super.onStart
    log.info("Starting MyConnectorExt")
  }

  override Void onStop()
  {
    log.info("Stopping MyConnectorExt")
  }

  // Required: Static accessor for use in Lib functions
  @NoDoc
  static MyConnectorExt cur(Bool checked := true)
  {
    return Context.cur.ext("myConnector", checked)
  }
}
```

### Step 3: Create Model Class (MyConnectorModel.fan)

The model defines connector prototype (form fields) and capabilities.

```fantom
using haystack
using connExt

@Js  // Required for UI
const class MyConnectorModel : ConnModel
{
  new make() : super(MyConnectorModel#.pod)
  {
    // Define fields shown in "New Connector" dialog
    connProto = Etc.makeDict([
      "dis": "My Connector",
      "myConnectorConn": Marker.val,  // Marker tag (connName + "Conn")
      "uri": `https://api.example.com/`,
      "username": "",
      "password": "",
      // Custom tags:
      "myCustomId": Number.zero
    ])
  }

  override const Dict connProto

  // Address type for points (usually Str# for string addresses)
  override Type? pointAddrType() { Str# }

  // Capability flags
  override Bool isPollingSupported() { true }
  override Bool isCurSupported() { true }
  override Bool isHisSupported() { true }
  override Bool isWriteSupported() { true }
  override Bool isLearnSupported() { true }
}
```

### Step 4: Create Connector Class (MyConnectorConn.fan)

```fantom
using concurrent
using haystack
using connExt
using folio
using axon

class MyConnectorConn : Conn
{
  MyConnectorClient? client { private set }

  // Constructor signature is fixed by framework
  new make(ConnActor actor, Dict rec) : super(actor, rec) {}

  override Obj? receive(ConnMsg msg) { return super.receive(msg) }

  // Called when connector opens
  override Void onOpen()
  {
    uri := rec["uri"] as Str
    if (uri == null) throw FaultErr("Missing 'uri' tag")

    username := rec["username"] as Str
    if (username == null) throw FaultErr("Missing 'username' tag")

    password := rec["password"] as Str
    if (password == null) throw FaultErr("Missing 'password' tag")

    client = MyConnectorClient(uri)
    client.authenticate(username, password)
  }

  // Called when connector closes
  override Void onClose()
  {
    client = null
  }

  // Verify connectivity
  override Dict onPing()
  {
    if (client == null) throw FaultErr("Not connected")
    // Make a test API call
    return Etc.makeDict(["ok": true])
  }

  // Discover available points
  override Grid onLearn(Obj? path)
  {
    if (client == null) throw FaultErr("Not connected")
    // Return grid of learnable points
    return Etc.makeEmptyGrid
  }
}
```

### Step 5: Create Library Class (MyConnectorLib.fan)

Required Axon functions that delegate to the extension.

```fantom
using haystack
using axon
using skyarcd

const class MyConnectorLib
{
  internal static const Log log := MyConnectorLib#.pod.log

  @NoDoc @Axon { admin = true }
  static Obj? myConnectorPing(Obj conn)
  {
    return MyConnectorExt.cur.connActor(conn).ping
  }

  @NoDoc @Axon { admin = true }
  static Obj? myConnectorLearn(Obj conn, Obj? arg := null)
  {
    return MyConnectorExt.cur.connActor(conn).learn(arg)
  }

  @NoDoc @Axon { admin = true }
  static Obj? myConnectorSyncCur(Obj points)
  {
    return MyConnectorExt.cur.syncCur(points)
  }

  @NoDoc @Axon { admin = true }
  static Obj? myConnectorSyncHis(Obj points, Obj? dates := null)
  {
    return MyConnectorExt.cur.syncHis(points, dates)
  }
}
```

### Step 6: Create Tag Definition Files

Create separate `.trio` files in the `lib/` directory:

**lib/conn.trio** - Connector definition:
```trio
//
// Copyright (c) 2026
// All Rights Reserved
//

--------------------------------------------------------------------------
def: ^myConnectorConn
is: ^conn
doc:
  My custom connector description.
--------------------------------------------------------------------------
defx: ^uri
tagOn: ^myConnectorConn
--------------------------------------------------------------------------
defx: ^username
tagOn: ^myConnectorConn
--------------------------------------------------------------------------
defx: ^password
tagOn: ^myConnectorConn
--------------------------------------------------------------------------
def: ^myCustomId
is: ^int
doc: "Custom ID for this connector"
tagOn: ^myConnectorConn
--------------------------------------------------------------------------
```

**lib/point.trio** - Point definitions:
```trio
//
// Copyright (c) 2026
// All Rights Reserved
//

--------------------------------------------------------------------------
def: ^myConnectorPoint
is: ^connPoint
doc:
  Point which synchronizes data via the MyConnector connector.
--------------------------------------------------------------------------
def: ^myConnectorConnRef
is: ^ref
of: ^myConnectorConn
tagOn: ^myConnectorPoint
doc:
  Used on a proxy point to reference its parent `myConnectorConn`
--------------------------------------------------------------------------
def: ^myConnectorCur
is: ^str
tagOn: ^myConnectorPoint
doc:
  Address for reading current value.
--------------------------------------------------------------------------
def: ^myConnectorHis
is: ^str
tagOn: ^myConnectorPoint
doc:
  Address for reading historical data.
--------------------------------------------------------------------------
def: ^myConnectorWrite
is: ^str
tagOn: ^myConnectorPoint
doc:
  Address for writing commands.
--------------------------------------------------------------------------
```

**Key points:**
- Use `conn.trio` and `point.trio` (NOT `lib.trio`)
- `def: ^myConnectorConn` with `is: ^conn` - Define the connector marker tag
- `defx: ^uri/^username/^password` - Extend standard tags for your connector
- `def: ^myConnectorPoint` with `is: ^connPoint` - Define point type
- `tagOn:` - Associates tags with your connector/point types

## Build and Deploy

### Compile
```bash
cd /path/to/myConnectorExt
fan build.fan
```

### Deploy to SkySpark
```bash
cp /path/to/fan/lib/fan/myConnectorExt.pod /path/to/skyspark/lib/fan/
```

### Restart SkySpark
```bash
cd /path/to/skyspark/bin
./skyspark stop
./skyspark start
```

### Enable Extension in Project

In SkySpark shell or Axon:
```axon
extAdd("myConnector")
```

Or via Host > Exts in the UI, add the "myConnector" extension to your project.

## Troubleshooting

### Connector not appearing in "New Conn" dropdown

1. **Verify pod is installed**: Check `/skyspark/lib/fan/myConnectorExt.pod` exists
2. **Check pod name**: Must end with `Ext`
3. **Verify index entries**: Both `skyarc.ext` and `skyarc.lib` required
4. **Enable extension**: Run `extAdd("myConnector")` in project
5. **Check lib.trio**: Must have `is: ^conn` and `connFeatures`
6. **Restart SkySpark**: Full restart required after pod changes

### Unknown type errors

- Ensure class names follow convention: `{Name}Ext`, `{Name}Model`, `{Name}Conn`, `{Name}Lib`
- Pod name `fooExt` expects classes: `FooExt`, `FooModel`, `FooConn`, `FooLib`

### Authentication/Credential errors

- Use `rec["username"]` and `rec["password"]` (standard field names)
- Don't prefix with connector name in rec lookup

## Common Patterns

### HTTP Client with JWT Authentication

```fantom
class MyConnectorClient
{
  Str baseUri
  Str? token
  Duration? tokenExpiry

  new make(Str baseUri) { this.baseUri = baseUri.trimEnd("/") }

  Void authenticate(Str username, Str password)
  {
    res := doPost("/auth/login", ["username": username, "password": password])
    token = res["token"]
    tokenExpiry = DateTime.now + 1hr
  }

  Void ensureAuthenticated()
  {
    if (token == null || DateTime.now > tokenExpiry)
      throw FaultErr("Token expired, reconnect required")
  }

  [Str:Obj?] get(Str path) { /* ... */ }
  [Str:Obj?] post(Str path, Obj? body) { /* ... */ }
}
```

### Learn Implementation

```fantom
class MyConnectorLearn
{
  MyConnectorConn conn

  new make(MyConnectorConn conn) { this.conn = conn }

  Grid learn(Str? path)
  {
    if (path == null) return learnDevices()
    return learnPoints(path)
  }

  Grid learnDevices()
  {
    devices := conn.client.get("/devices")
    gb := GridBuilder()
    gb.addCol("learn").addCol("dis").addCol("deviceId")
    (devices["data"] as List)?.each |d|
    {
      id := d["id"]
      name := d["name"]
      gb.addRow([id.toStr, name, Number(id)])
    }
    return gb.toGrid
  }

  Grid learnPoints(Str deviceId)
  {
    points := conn.client.get("/devices/$deviceId/points")
    gb := GridBuilder()
    gb.addCol("learn").addCol("dis").addCol("point").addCol("kind")
    // ... build point rows
    return gb.toGrid
  }
}
```

## Reference Connectors

For additional patterns, study these connectors:
- `milesightExt` - IoT sensor connector
- `bassgConedGreenButtonDataExt` - Green Button utility data connector
- Built-in SkySpark connectors in `/skyspark/lib/fan/`
