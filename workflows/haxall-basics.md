# Haxall Basics

This guide introduces Haxall, the modern IoT and building automation platform built on Fantom.

## What is Haxall?

Haxall is an open-source software framework for:
- IoT applications
- Building automation systems
- Data acquisition and monitoring
- Edge computing
- Smart building management

Built on Fantom, Haxall provides a powerful, lightweight runtime for working with real-world data.

## Key Concepts

### Projects (Haystack Data)

Haxall stores data as **Haystack tags** in a **project database**. Everything is a record with tags:

```
dis: "Office-1 Air Temp"
point
sensor
temp
air
unit: "°F"
siteRef: @building-123
equipRef: @ahu-1
```

### Functions

Haxall uses Axon, a functional scripting language for data queries and automation:

```axon
// Query all temp sensors
readAll(temp and sensor)

// Calculate average
readAll(temp and sensor).avg(v => v->curVal)
```

### Extensions

Haxall is modular. Add capabilities via extensions:
- `hxConn` - Protocol connectors (BACnet, Modbus, etc.)
- `hxPoint` - Point management
- `hxTask` - Task scheduling
- `hxUser` - User authentication

## Getting Started

### Installation

1. Download Haxall from https://haxall.io/
2. Extract to a directory
3. Add `bin/` to your PATH

### Create a New Project

```bash
# Create project
hx init myproject

# Start daemon
cd myproject
hx run
```

Access the web interface at `http://localhost:8080`

### Default Credentials

```
Username: su
Password: (blank)
```

**Change immediately in production!**

## Working with Records

### Create a Site

```axon
commit(diff(null, {
  dis: "Headquarters",
  site,
  area: 50000,
  areaUnit: "ft²",
  geoAddr: "123 Main St, City, State",
  tz: "New_York"
}))
```

### Create an Equip

```axon
commit(diff(null, {
  dis: "AHU-1",
  equip,
  ahu,
  siteRef: @hq
}))
```

### Create a Point

```axon
commit(diff(null, {
  dis: "AHU-1 Discharge Air Temp",
  point,
  sensor,
  temp,
  discharge,
  air,
  unit: "°F",
  siteRef: @hq,
  equipRef: @ahu1,
  kind: "Number"
}))
```

## Querying Data

### Basic Queries

```axon
// All points
readAll(point)

// Temp sensors
readAll(temp and sensor)

// Points on a specific equip
readAll(point and equipRef==@ahu1)

// Get single record by ID
read(@p:demo:r:123)
```

### Filtering and Projection

```axon
// Filter with function
readAll(point).findAll(v => v->curVal > 70)

// Select specific columns
readAll(point).keepCols(["dis", "curVal", "unit"])

// Sort results
readAll(point).sort("dis")
```

## Writing Data

### Update Current Value

```axon
// Write single point
pointWrite(@p:demo:r:temp, 72.5)

// Write with priority (1-17, 1=highest)
pointWrite(@p:demo:r:damper, 50, 8)
```

### Update Tags

```axon
// Add/update tags
commit(diff(read(@p:demo:r:temp), {
  customTag: "value",
  anotherTag: marker()
}))

// Remove tag
commit(diff(read(@p:demo:r:temp), {
  customTag: remove()
}))
```

## Tasks and Scheduling

### Create a Task

```axon
task: {
  dis: "Hourly Average Calculator"
  task
  taskExpr: ```
    // Calculate hourly averages
    points: readAll(temp and sensor)
    points.each(p => do
      avg: hisPastWeek(p.id).avg(v => v->val)
      echo("$p.dis: $avg")
    end)
  ```
  taskFreq: 1hr
}
```

### Manual Task Execution

```axon
// Run a task immediately
task(doSomething())
```

## Connectors

### BACnet Example

```axon
// Create BACnet connector
commit(diff(null, {
  dis: "BACnet Network",
  conn,
  bacnet,
  uri: "bacnet://192.168.1.0/24",
  bacnetPort: 47808
}))

// Discover devices
connDiscover(@bacnet-conn)

// Map a point
commit(diff(null, {
  dis: "Room Temp",
  point,
  sensor,
  temp,
  connRef: @bacnet-conn,
  bacnetDevice: 1234,
  bacnetObj: "analogInput,1",
  kind: "Number",
  unit: "°F"
}))
```

### Modbus Example

```axon
// Create Modbus connector
commit(diff(null, {
  dis: "Modbus Controller",
  conn,
  modbus,
  uri: "modbus://192.168.1.100:502"
}))

// Create Modbus point
commit(diff(null, {
  dis: "Pressure Sensor",
  point,
  sensor,
  pressure,
  connRef: @modbus-conn,
  modbusReg: 40001,
  modbusType: "holding",
  kind: "Number",
  unit: "psi"
}))
```

## Creating Extensions

### Basic Extension Structure

Create `build.fan`:

```fantom
using build

class Build : BuildPod
{
  new make()
  {
    podName = "hxMyExt"
    summary = "My Haxall extension"
    version = Version("1.0")
    depends = [
      "sys 1.0",
      "concurrent 1.0",
      "haystack 3.1",
      "axon 3.1",
      "hx 3.1"
    ]
    srcDirs = [`fan/`]
    resDirs = [,]
    index = [
      "hx.ext": "myExt::MyExtMeta"
    ]
  }
}
```

Create extension metadata:

```fantom
using haystack
using hx

const class MyExtMeta : HxExtMeta
{
  override HxExtManifest manifest()
  {
    HxExtManifest
    {
      name = "myExt"
      dis = "My Extension"
      version = Version("1.0")
      depends = Str:Str["hx":"3.1"]
    }
  }
  
  override Void onStart(HxContext cx)
  {
    echo("MyExt started!")
  }
}
```

### Adding Axon Functions

```fantom
using axon
using haystack

@Axon
class MyFuncs
{
  @Axon { admin = false }
  static Obj? greet(Str name)
  {
    "Hello, $name!"
  }
  
  @Axon
  static Grid calculateAverage(Grid g, Str col)
  {
    vals := g.colToList(col)
    avg := vals.reduce(0f) { sum, v -> sum + v } / vals.size
    return Etc.makeDict(["average": Number(avg)])
  }
}
```

Register functions in ext:

```fantom
override Void onReady(HxContext cx)
{
  cx.rt.libs.add(MyFuncs#)
}
```

## Historical Data

### Recording History

Enable historization on a point:

```axon
commit(diff(read(@p:demo:r:temp), {
  his,
  hisCollectInterval: 1min,
  hisCollectCov: 0.5
}))
```

### Querying History

```axon
// Last 24 hours
hisRead(@p:demo:r:temp, yesterday())

// Date range
hisRead(@p:demo:r:temp, 2024-01-01..2024-01-31)

// Rollup to hourly
hisRead(@p:demo:r:temp, lastWeek()).hisRollup(avg, 1hr)
```

## Best Practices

### Tagging Standards

Follow Project Haystack tagging conventions:
- Use standard tags when available
- Add `dis` (display name) to all records
- Use `siteRef`, `equipRef` for hierarchy
- Include `unit` for numeric points
- Use `kind` to specify data type

### Performance

- Index frequently queried tags
- Use `readAll()` filters efficiently
- Limit grid sizes in functions
- Cache expensive calculations

### Security

- Change default passwords
- Use strong authentication
- Implement role-based access
- Secure network communications
- Regular backups

## Common Patterns

### Point Calculation

```axon
// Derived point calculation
@p:demo:r:totalPower: do
  p1: readById(@p:demo:r:power1)->curVal
  p2: readById(@p:demo:r:power2)->curVal
  p1 + p2
end
```

### Alarming

```axon
// High temp alarm
@p:demo:r:temp->curVal > 80 ? 
  alarmSet(@p:demo:r:temp, "High temperature detected!") :
  alarmClear(@p:demo:r:temp)
```

### Batch Operations

```axon
// Update multiple points
points: readAll(sensor and temp)
points.each(p => do
  commit(diff(p, {newTag: "value"}))
end)
```

## Next Steps

- Explore the Axon language reference
- Set up real connectors (BACnet, Modbus, etc.)
- Build custom extensions
- Integrate with external systems
- Deploy to production

## Resources

- Official documentation: https://haxall.io/doc/
- Project Haystack: https://project-haystack.org/
- Community forums
- GitHub repository: https://github.com/haxall/haxall
