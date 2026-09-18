# Creating a SkySpark Extension Pod

This guide walks you through creating a SkySpark extension pod that registers properly in the SkySpark Settings → Exts list.

## What is a SkySpark Extension?

A SkySpark extension is a Fantom pod that:
- Extends SkySpark functionality with custom features
- Appears in Settings → Exts for project-level enabling/disabling
- Can provide Axon functions, HTTP endpoints, background services
- Integrates with SkySpark's lifecycle (start/stop hooks)

## Prerequisites

- SkySpark 3.x installed
- Fantom runtime (comes with SkySpark)
- Access to `skyarcd` and related pods

## Directory Structure

```
myExt/
├── build.fan           # Build configuration
├── buildLocal.fan      # Local build script (optional)
├── fan/
│   ├── MyExt.fan       # Extension class (required)
│   ├── MyLib.fan       # Axon function library (required)
│   └── ...             # Other source files
├── locale/
│   └── en.props        # Localization strings (required)
├── doc/
│   └── index.fandoc    # Documentation (optional)
└── test/
    └── MyExtTest.fan   # Unit tests (optional)
```

## Step 1: Create build.fan

The `build.fan` file MUST include the `index` entries to register with SkySpark:

```fantom
#! /usr/bin/env fan

using build

class Build : BuildPod
{
  new make()
  {
    podName = "acmeMyExt"
    summary = "My SkySpark Extension"
    version = Version("1.0.0")
    meta = [
      "org.name":     "Acme Corp",
      "license.name": "Commercial",
    ]

    // REQUIRED: SkySpark dependencies
    depends = [
      "sys 1.0",
      "concurrent 1.0",
      "web 1.0",
      "util 1.0",
      "haystack 3.0+",
      "folio 3.0+",
      "axon 3.0+",
      "skyarcd 3.0+",
      // Add if using licensed extension base class
      // "bassgCommon 3.0+"
    ]

    srcDirs = [`fan/`, `test/`]
    resDirs = [`locale/`, `doc/`]

    // CRITICAL: These index entries register the extension
    index = [
      "skyarc.ext": "acmeMyExt::MyExt",
      "skyarc.lib": "acmeMyExt::MyLib",
    ]

    docApi = true
    docSrc = true
  }
}
```

## Step 2: Create the Extension Class

The extension class MUST:
- Be a `const class`
- Have `@ExtMeta` annotation
- Extend `Ext` (or `LicensedExt` for licensed extensions)
- Have a no-arg constructor

```fantom
// fan/MyExt.fan

using web
using haystack
using skyarcd

**
** My SkySpark Extension
**
@ExtMeta
{
  name    = "acmeMyExt"           // Extension identifier
  icon    = "puzzle"              // Icon from Fresco library
  depends = Str[,]                // Extension dependencies (not pod deps)
}
const class MyExt : Ext
{
  ** No-arg constructor required
  @NoDoc new make() : super() {}

  ** Called when extension starts
  override Void onStart()
  {
    super.onStart
    log.info("MyExt starting...")
    // Initialize your extension here
  }

  ** Called when extension stops
  override Void onStop()
  {
    log.info("MyExt stopping...")
    // Cleanup resources here
    super.onStop
  }
}
```

### For Licensed Extensions (with bassgCommon)

If using `LicensedExt` from bassgCommon:

```fantom
using web
using haystack
using skyarcd
using bassgCommon

@ExtMeta
{
  name    = "acmeMyExt"
  icon    = "puzzle"
  depends = Str["bassgCommon"]
}
const class MyExt : LicensedExt, web::Weblet
{
  @NoDoc new make() : super() {}

  override Void onStart()
  {
    super.onStart
    if (!licensed) return  // Check license
    // Initialize
  }

  override Void onStop()
  {
    super.onStop
    // Cleanup
  }

  ** Handle HTTP requests to extension endpoint
  override Void onService()
  {
    if (req.modRel.path.first == "status")
    {
      res.headers["Content-Type"] = "application/json"
      res.out.print(`{"status":"ok"}`).close
    }
  }
}
```

## Step 3: Create the Axon Library Class

The library class provides Axon functions:

```fantom
// fan/MyLib.fan

using haystack
using axon

**
** Axon functions for MyExt
**
const class MyLib
{
  **
  ** Get extension status.
  ** Example: myExtStatus()
  **
  @Axon { admin = true }
  static Dict myExtStatus()
  {
    return Etc.makeDict([
      "running": true,
      "version": "1.0.0"
    ])
  }

  **
  ** Perform an action.
  ** Example: myExtDoSomething("hello")
  **
  @Axon { admin = true }
  static Str myExtDoSomething(Str input)
  {
    return "Processed: $input"
  }
}
```

### Axon Function Guidelines

- Use `@Axon { admin = true }` for admin-only functions
- All methods must be `static`
- Return Haystack types: `Dict`, `Grid`, `Marker`, `Number`, `Str`, etc.
- Document with Fandoc comments (becomes Axon help)

## Step 4: Create Locale File

The locale file provides the display name in SkySpark UI:

```properties
# locale/en.props

# Extension display name (REQUIRED)
# Format: {extMetaName}.ext.dis=Display Name
acmeMyExt.ext.dis=My Extension

# Optional: Other localizable strings
myExt.status.running=Running
myExt.status.stopped=Stopped
```

**Important:** The locale key format is `{name}.ext.dis` where `{name}` matches the `@ExtMeta.name` value.

## Step 5: Create buildLocal.fan (For Version-Specific Builds)

If you have a separate `buildLocal.fan` for building against a specific SkySpark version, **it MUST also include the `index` entries**. This is a common pitfall!

```fantom
#! /usr/bin/env fan

using build

class Build : BuildPod
{
  new make()
  {
    podName = "acmeMyExt"
    summary = "My SkySpark Extension"
    version = Version("3.1.8.0")  // Match SkySpark version
    meta = [
      "org.name":     "Acme Corp",
      "license.name": "Commercial",
    ]

    // Version-specific dependencies
    depends = [
      "sys 1.0",
      "concurrent 1.0",
      "web 1.0",
      "util 1.0",
      "haystack 3.1",      // Specific version
      "folio 3.1",
      "axon 3.1",
      "skyarcd 3.1",
    ]

    srcDirs = [`fan/`, `test/`]
    resDirs = [`doc/`, `locale/`]  // Don't forget locale/

    // CRITICAL: Must include index in buildLocal.fan too!
    // Without this, the pod will compile but NOT register as an extension
    index = [
      "skyarc.ext": "acmeMyExt::MyExt",
      "skyarc.lib": "acmeMyExt::MyLib",
    ]

    // Output directly to SkySpark lib directory
    outPodDir = `/path/to/skyspark/lib/fan/`

    docApi = true
    docSrc = true
  }
}
```

**Common Mistake:** Having `index` in `build.fan` but forgetting it in `buildLocal.fan`. The compiled pod will have no `index.props` file and SkySpark won't discover it.

## Step 6: Build the Pod

```bash
# Standard build
fan build.fan

# Or with local SkySpark version
fan buildLocal.fan
```

## Step 7: Verify the Compiled Pod

After building, **always verify** the pod contains `index.props`:

```bash
# Check pod contents
unzip -l myExt.pod | grep -E "(index|locale)"

# Expected output:
#   index.props        <- CRITICAL: Must exist!
#   locale/en.props    <- Required for display name

# Verify index.props contents
unzip -p myExt.pod index.props

# Expected output:
# skyarc.ext=acmeMyExt::MyExt
# skyarc.lib=acmeMyExt::MyLib
```

If `index.props` is missing, the extension **will not appear** in Settings → Exts.

## Step 8: Deploy and Enable

1. Copy the `.pod` file to SkySpark's `lib/fan/` directory
2. Restart SkySpark (required for new pods)
3. Go to Settings → Exts
4. Enable your extension for the project

## @ExtMeta Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | Str | Yes | Unique identifier (valid tag name) |
| `icon` | Str | Yes | Fresco icon name (e.g., "puzzle", "bolt") |
| `depends` | Str[] | No | Extension dependencies (default: empty) |

**Deprecated fields (still work but show warnings):**
- `icon24` / `icon72` - Use `icon` instead

## Common Icons

- `puzzle` - Generic extension
- `bolt` - Energy/power related
- `db` - Database related
- `calendar` - Scheduling
- `mail` - Notifications
- `map` - Geolocation
- `his` - History
- `check` - Status OK

## Extension Lifecycle

```
┌─────────────────┐
│   Pod Loaded    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Extension     │
│   Registered    │  (via skyarc.ext index)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Ext.onStart() │  (when project starts or ext enabled)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Running       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Ext.onStop()  │  (when project stops or ext disabled)
└─────────────────┘
```

## Accessing Project Context

Within extension methods:

```fantom
// Get the project
proj := rt.proj

// Read a record
rec := proj.readById(id)

// Get extension config from project record
port := rec.get("myExtPort", 8080)
```

## Adding HTTP Endpoints

If extending `web::Weblet`:

```fantom
override Void onService()
{
  path := req.modRel.path.first

  switch (path)
  {
    case "status":
      sendJson(["status": "ok"])
    case "restart":
      doRestart()
      sendJson(["restarted": true])
    default:
      res.sendErr(404)
  }
}

private Void sendJson(Obj data)
{
  res.headers["Content-Type"] = "application/json"
  res.out.print(JsonOutStream.writeJsonToStr(data)).close
}
```

## Checklist

Before deploying, verify:

- [ ] `build.fan` has `index` with `skyarc.ext` and `skyarc.lib`
- [ ] `buildLocal.fan` ALSO has `index` entries (if using local build)
- [ ] `resDirs` includes `locale/` directory
- [ ] Ext class has `@ExtMeta` annotation with `name` and `icon`
- [ ] Ext class is `const` with `@NoDoc new make() : super() {}`
- [ ] Lib class exists (can be empty)
- [ ] `locale/en.props` has `{name}.ext.dis=Display Name`
- [ ] All dependencies declared in `build.fan`
- [ ] Pod builds without errors
- [ ] **Compiled pod contains `index.props`** (verify with `unzip -l`)

## Troubleshooting

### Extension doesn't appear in Settings → Exts

**Most Common Cause: Missing `index.props` in compiled pod**

1. **Verify the pod has index.props:**
   ```bash
   unzip -l /path/to/myExt.pod | grep index.props
   ```
   If nothing shows, the index entries are missing from your build file.

2. **Check BOTH build.fan AND buildLocal.fan have index entries:**
   ```fantom
   index = [
     "skyarc.ext": "podName::ExtClass",
     "skyarc.lib": "podName::LibClass",
   ]
   ```
   **This is the #1 cause of extensions not appearing!**

3. **Check locale file** has display name in `locale/en.props`:
   ```properties
   {extMetaName}.ext.dis=Display Name
   ```

4. **Verify resDirs includes locale:**
   ```fantom
   resDirs = [`doc/`, `locale/`]  // locale/ must be included!
   ```

5. **Restart SkySpark** - new pods require full restart

6. **Check SkySpark logs** for load errors:
   ```bash
   tail -100 /path/to/skyspark/var/log/log-*.log | grep -i error
   ```

### Quick Diagnostic Commands

```bash
# 1. Check pod has required files
unzip -l myExt.pod | grep -E "(index|locale|meta)"

# 2. Verify index.props contents
unzip -p myExt.pod index.props
# Should show:
# skyarc.ext=podName::ExtClass
# skyarc.lib=podName::LibClass

# 3. Verify locale
unzip -p myExt.pod locale/en.props
# Should show:
# extName.ext.dis=Display Name

# 4. Compare with working extension
unzip -l workingExt.pod | grep -E "(index|locale)"
```

### Extension appears but won't enable

1. **Check dependencies** - all required pods must be installed
2. **Check @ExtMeta.depends** - listed extensions must be enabled first
3. **Check license** (for LicensedExt) - extension marked FAULT if not licensed
4. **Check SkySpark logs** for specific error messages

### Axon functions not available

1. **Check skyarc.lib index** points to correct class
2. **Verify @Axon annotation** on methods
3. **Methods must be static**
4. **Verify lib class is const**

### LicensedExt specific issues

If extending `LicensedExt` from bassgCommon:

1. **License file required** at `var/lic/[extName].bassg.lic`
2. **Must check `if (!licensed) return`** in onStart()
3. **Extension shows FAULT status** if license validation fails
4. **Anka Organization projects** with ≤60 points get automatic trial license

## Example: Complete Minimal Extension

### build.fan
```fantom
using build

class Build : BuildPod
{
  new make()
  {
    podName = "acmeHelloExt"
    summary = "Hello World Extension"
    version = Version("1.0.0")
    meta = ["org.name": "Acme", "license.name": "MIT"]
    depends = ["sys 1.0", "haystack 3.0+", "axon 3.0+", "skyarcd 3.0+"]
    srcDirs = [`fan/`]
    resDirs = [`locale/`]
    index = [
      "skyarc.ext": "acmeHelloExt::HelloExt",
      "skyarc.lib": "acmeHelloExt::HelloLib",
    ]
  }
}
```

### fan/HelloExt.fan
```fantom
using haystack
using skyarcd

@ExtMeta { name = "acmeHello"; icon = "puzzle" }
const class HelloExt : Ext
{
  @NoDoc new make() : super() {}
  override Void onStart() { super.onStart; log.info("Hello started!") }
  override Void onStop() { log.info("Hello stopped!"); super.onStop }
}
```

### fan/HelloLib.fan
```fantom
using haystack
using axon

const class HelloLib
{
  @Axon static Str hello(Str name) { "Hello, $name!" }
}
```

### locale/en.props
```properties
acmeHello.ext.dis=Hello World
```

## Related Workflows

- [Creating a Fantom Pod](workflow://create-pod) - Basic pod creation
- [Unit Testing](workflow://unit-testing) - Writing tests
- [Haxall Basics](workflow://haxall-basics) - Haxall integration
