# Xeto Specification Guide for SkySpark 4.0

Complete guide to writing Xeto specs for SkySpark 4.0 extensions and functions.

## What is Xeto?

Xeto (pronounced "zeeto") is a data modeling language used in SkySpark 4.0 to define:
- Extension metadata and dependencies
- Function signatures and implementations
- Type specifications
- Library structure

## File Structure

```
myExt/
  lib/
    lib.trio         # Library metadata
    lib.xeto         # Type specifications
    funcs.xeto       # Function definitions
    settings.xeto    # Settings schema (optional)
```

## lib.trio - Library Metadata

Defines the library metadata in Trio format:

```trio
dis: "My Extension"
version: "1.0.5"
icon: "cog"
doc: "Brief description of the extension"

depends: [
  {lib: "sys"},
  {lib: "ph"},
  {lib: "hx"},
  {lib: "hx.task", versions: "4.0+"}
]

org: {
  dis: "My Company Name"
  uri: "https://mycompany.com"
}

license: {
  name: "MIT License"
  uri: "https://opensource.org/licenses/MIT"
}
```

### Common Metadata Fields

| Field | Type | Description |
|-------|------|-------------|
| `dis` | Str | Display name |
| `version` | Str | Semantic version (x.y.z) |
| `icon` | Str | Icon name from icon library |
| `doc` | Str | Short description |
| `depends` | List | Library dependencies |
| `org` | Dict | Organization info |
| `license` | Dict | License information |

### Dependency Specification

```trio
depends: [
  {lib: "sys"},                          # Any version
  {lib: "hx", versions: "4.0+"},         # Min version
  {lib: "hx.task", versions: "4.0-4.2"}, # Version range
  {lib: "myco.util", versions: "1.2.3"}  # Exact version
]
```

## lib.xeto - Type Specifications

Define custom types and specifications:

```xeto
// Simple type alias
MyId: Ref

// Type with constraints
PositiveInt: Int <minVal:0>

// Custom marker tag
myCustomTag: Marker

// Enum-like choice
MyStatus: Str <enum: ["pending", "active", "complete"]>

// Complex specification
MyDevice: Dict {
  dis: Str
  myDeviceTag: Marker
  ipAddr: Str
  port: Int <minVal:1, maxVal:65535>
  protocol: Str <enum: ["tcp", "udp"]>
  timeout: Number <unit:"sec", minVal:0>
}

// Equipment specification (Haystack)
MyEquip: Equip {
  myEquip: Marker
  modelNumber: Str?
  manufacturer: Str?
}

// Point specification (Haystack)
MyPoint: Point {
  myPoint: Marker
  myEquipRef: Ref <of:MyEquip>
  kind: Str <enum: ["Number", "Bool", "Str"]>
  unit: Str?
}
```

### Xeto Type Syntax

**Basic Types:**
- `Marker` - Tag marker
- `Str` - String
- `Int` - Integer number
- `Number` - Floating point
- `Bool` - Boolean
- `Ref` - Reference to another record
- `Date` - Date value
- `Time` - Time value
- `DateTime` - Date and time
- `Uri` - URI value
- `Dict` - Dictionary/map
- `List` - List of values

**Modifiers:**
- `?` - Optional (nullable): `Str?`
- `<>` - Constraints: `Int <minVal:0, maxVal:100>`
- `:` - Type definition: `MyType: Str`

**Constraints:**
```xeto
temperature: Number <
  unit: "°F",
  minVal: -40,
  maxVal: 140
>

email: Str <
  pattern: "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$"
>

choices: Str <
  enum: ["option1", "option2", "option3"]
>

reference: Ref <
  of: MyEquip
>
```

## funcs.xeto - Function Definitions

Define Axon and Fantom functions:

### Axon Functions

**Simple Axon function:**
```xeto
myAdd: Func {
  doc: "Add two numbers"
  a: Number
  b: Number
  returns: Number
  <axon:---
  (a, b) => a + b
  --->
}
```

**Function with optional parameters:**
```xeto
myGreet: Func {
  doc: "Generate greeting message"
  name: Str
  formal: Bool <def:false>
  returns: Str
  <axon:---
  (name, formal:false) => do
    prefix: formal ? "Good day" : "Hi"
    prefix + ", " + name
  end
  --->
}
```

**Function with admin restriction:**
```xeto
myAdminFunc: Func {
  doc: "Admin only function"
  admin: Marker
  returns: Str
  <axon:---
  () => "Admin access granted"
  --->
}
```

**Multi-line Axon function:**
```xeto
myComplexFunc: Func {
  doc: "Complex calculation with multiple steps"
  inputs: List
  threshold: Number <def:100>
  returns: Dict
  <axon:---
  (inputs, threshold:100) => do
    // Filter values above threshold
    filtered: inputs.findAll(v => v > threshold)
    
    // Calculate statistics
    result: {
      count: filtered.size,
      sum: filtered.sum,
      avg: filtered.avg,
      max: filtered.max
    }
    
    result
  end
  --->
}
```

### Fantom Function Stubs

**Fantom-implemented function:**
```xeto
myFantomFunc: Func {
  doc: "Function implemented in Fantom"
  input: Str
  options: Dict?
  returns: Dict
  // No <axon:...> tag means Fantom implementation
}
```

**Corresponding Fantom code:**
```fantom
using hx

class MyExtFuncs : ExtObj {
  @Api
  static Dict myFantomFunc(Context cx, Str input, Dict? options := null) {
    // Implementation
    return Etc.makeDict(["result": input, "processed": true])
  }
}
```

**Admin-only Fantom function:**
```xeto
mySecureFunc: Func {
  doc: "Requires admin privileges"
  admin: Marker
  data: Str
  returns: Str
}
```

```fantom
@Api { admin = true }
static Str mySecureFunc(Context cx, Str data) {
  // Only admins can call this
  return "Processed: $data"
}
```

### Function Parameter Types

**Common parameter patterns:**

```xeto
// Required parameters
myFunc: Func {
  requiredStr: Str
  requiredNum: Number
  requiredRef: Ref
}

// Optional parameters (with default in Axon)
myFunc: Func {
  optionalStr: Str <def:"default">
  optionalNum: Number <def:0>
  optionalBool: Bool <def:false>
}

// Optional parameters (nullable)
myFunc: Func {
  optionalDict: Dict?
  optionalList: List?
}

// Typed references
myFunc: Func {
  equipRef: Ref <of:Equip>
  siteRef: Ref <of:Site>
}

// Constrained values
myFunc: Func {
  mode: Str <enum:["auto", "manual", "off"]>
  priority: Int <minVal:1, maxVal:17>
  temp: Number <unit:"°F">
}

// Complex types
myFunc: Func {
  config: Dict {
    timeout: Number
    retries: Int
    enabled: Bool
  }
  ids: List <of:Ref>
}
```

## settings.xeto - Settings Schema (Optional)

Define configuration schema for your extension:

```xeto
// Settings specification
Settings: Dict {
  doc: "Extension settings"
  
  // Connection settings
  uri: Uri {
    doc: "Server connection URI"
  }
  
  port: Int <minVal:1, maxVal:65535, def:502> {
    doc: "Server port"
  }
  
  // Polling settings
  pollRate: Number <unit:"sec", minVal:1, def:5> {
    doc: "Polling interval in seconds"
  }
  
  timeout: Number <unit:"sec", minVal:1, maxVal:300, def:30> {
    doc: "Request timeout"
  }
  
  // Retry settings
  maxRetries: Int <minVal:0, maxVal:10, def:3> {
    doc: "Maximum retry attempts"
  }
  
  retryDelay: Number <unit:"sec", minVal:0, def:1> {
    doc: "Delay between retries"
  }
  
  // Authentication
  username: Str? {
    doc: "Optional username"
  }
  
  password: Str? {
    doc: "Optional password (encrypted)"
  }
  
  // Logging
  logLevel: Str <enum:["debug", "info", "warn", "error"], def:"info"> {
    doc: "Logging verbosity level"
  }
  
  // Feature flags
  enableCache: Bool <def:true> {
    doc: "Enable response caching"
  }
  
  autoReconnect: Bool <def:true> {
    doc: "Automatically reconnect on failure"
  }
}
```

## Complete Example: Connector Extension

### lib/lib.trio
```trio
dis: "My Connector"
version: "1.0.0"
icon: "plugin"
doc: "Connector for custom protocol devices"

depends: [
  {lib: "sys"},
  {lib: "ph"},
  {lib: "hx"},
  {lib: "hxConn"}
]

org: {
  dis: "My Company"
  uri: "https://mycompany.com"
}
```

### lib/lib.xeto
```xeto
// Equipment spec
MyDevice: Equip {
  doc: "My custom device"
  myDevice: Marker
  ipAddr: Str
  deviceId: Int
}

// Point specs
MyTempPoint: Point {
  doc: "Temperature sensor point"
  myPoint: Marker
  temp: Marker
  sensor: Marker
  myDeviceRef: Ref <of:MyDevice>
  kind: "Number"
  unit: "°F"
}

MyStatusPoint: Point {
  doc: "Status point"
  myPoint: Marker
  status: Marker
  myDeviceRef: Ref <of:MyDevice>
  kind: "Bool"
}
```

### lib/funcs.xeto
```xeto
// Discovery function
myDiscover: Func {
  doc: "Discover devices on network"
  networkRange: Str
  returns: List
}

// Read function
myRead: Func {
  doc: "Read value from device"
  deviceId: Int
  register: Int
  returns: Number?
}

// Axon helper function
myParseData: Func {
  doc: "Parse device data format"
  rawData: Str
  returns: Dict
  <axon:---
  (rawData) => do
    // Parse comma-separated values
    parts: rawData.split(",")
    {
      temp: parts[0].parseNumber,
      humidity: parts[1].parseNumber,
      status: parts[2] == "1"
    }
  end
  --->
}
```

### lib/settings.xeto
```xeto
Settings: Dict {
  doc: "Connector settings"
  
  networkRange: Str <def:"192.168.1.0/24"> {
    doc: "Network range for discovery"
  }
  
  pollRate: Number <unit:"sec", minVal:1, def:5> {
    doc: "Polling rate"
  }
  
  timeout: Number <unit:"sec", minVal:1, def:10> {
    doc: "Communication timeout"
  }
  
  port: Int <minVal:1, maxVal:65535, def:5000> {
    doc: "Device communication port"
  }
}
```

## Best Practices

### 1. Documentation

Always add `doc` fields:
```xeto
myFunc: Func {
  doc: "Clear description of what this function does"
  param1: Str {
    doc: "Description of param1"
  }
}
```

### 2. Type Safety

Use specific types and constraints:
```xeto
// Good - specific constraints
port: Int <minVal:1, maxVal:65535>
temperature: Number <unit:"°F", minVal:-40, maxVal:140>

// Avoid - too generic
port: Number
temperature: Number
```

### 3. Defaults

Provide sensible defaults for optional parameters:
```xeto
myFunc: Func {
  required: Str
  optional: Int <def:10>
  flag: Bool <def:false>
}
```

### 4. Enums for Choices

Use enums instead of free-form strings:
```xeto
// Good
mode: Str <enum:["auto", "manual", "off"]>

// Avoid
mode: Str  // Any string accepted
```

### 5. Reference Types

Specify what references point to:
```xeto
// Good
equipRef: Ref <of:Equip>
siteRef: Ref <of:Site>

// Avoid
equipRef: Ref  // Reference to what?
```

### 6. Units

Always specify units for physical quantities:
```xeto
// Good
temperature: Number <unit:"°F">
duration: Number <unit:"sec">
power: Number <unit:"kW">

// Avoid
temperature: Number
```

## Common Patterns

### Admin-Only Function
```xeto
adminFunc: Func {
  doc: "Function requiring admin access"
  admin: Marker
  data: Str
  returns: Str
}
```

### Function with Complex Return Type
```xeto
getSummary: Func {
  doc: "Get summary statistics"
  ids: List <of:Ref>
  returns: Dict {
    count: Int
    avg: Number
    min: Number
    max: Number
  }
}
```

### Optional Configuration Dict
```xeto
processData: Func {
  doc: "Process data with options"
  data: List
  opts: Dict? {
    threshold: Number?
    filter: Str?
    sortBy: Str?
  }
  returns: List
}
```

### Haystack Queries
```xeto
findPoints: Func {
  doc: "Find points matching criteria"
  filter: Str {
    doc: "Haystack filter expression"
  }
  limit: Int <def:100> {
    doc: "Max results"
  }
  returns: List <of:Ref>
}
```

## Validation

The Xeto compiler validates:
- Syntax correctness
- Type consistency
- Constraint satisfaction
- Dependency resolution

Build errors will show:
```
ERROR: Invalid type constraint
  File: lib/funcs.xeto
  Line: 15
  Invalid minVal for Str type
```

## See Also

- **skyspark-4x-migration.md** - Migration guide
- **api-migration-reference.md** - API mappings
- **docHaystack::Xeto** - Official Xeto documentation
- **Haxall repo** - Real-world examples
