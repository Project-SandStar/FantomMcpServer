# Fantom Code Generation Examples

The `generateFantomCode` MCP tool can generate Fantom classes, methods, mixins, enums, and pod scaffolds.

## Quick Reference

### Generate a Simple Class

```json
{
  "type": "class",
  "name": "Person",
  "pod": "myApp",
  "doc": "Represents a person",
  "fields": [
    { "name": "firstName", "type": "Str" },
    { "name": "lastName", "type": "Str" },
    { "name": "age", "type": "Int" }
  ],
  "methods": [
    {
      "name": "fullName",
      "returnType": "Str",
      "body": "return \"$firstName $lastName\""
    }
  ]
}
```

**Output:**
```fantom
**
** Represents a person
**
class Person
{
  Str firstName
  Str lastName
  Int age

  Str fullName()
  {
    return "$firstName $lastName"
  }
}
```

---

### Generate a Class with Inheritance and Mixins

```json
{
  "type": "class",
  "name": "Employee",
  "pod": "myApp",
  "extends": "Person",
  "mixins": ["Worker", "Auditable"],
  "fields": [
    { "name": "employeeId", "type": "Str", "isFinal": true },
    { "name": "department", "type": "Str" }
  ],
  "methods": [
    {
      "name": "new",
      "returnType": "This",
      "params": [
        { "name": "id", "type": "Str" },
        { "name": "dept", "type": "Str" }
      ],
      "body": "this.employeeId = id\n    this.department = dept"
    }
  ]
}
```

**Output:**
```fantom
class Employee : Person, Worker, Auditable
{
  const Str employeeId
  Str department

  new make(Str id, Str dept)
  {
    this.employeeId = id
    this.department = dept
  }
}
```

---

### Generate an Enum

```json
{
  "type": "enum",
  "name": "Status",
  "pod": "myApp",
  "doc": "Order status values",
  "enumValues": ["pending", "active", "completed", "cancelled"]
}
```

**Output:**
```fantom
**
** Order status values
**
enum class Status
{
  pending,
  active,
  completed,
  cancelled
}
```

---

### Generate a Mixin

```json
{
  "type": "mixin",
  "name": "Auditable",
  "pod": "myApp",
  "doc": "Provides audit tracking capabilities",
  "fields": [
    { "name": "createdAt", "type": "DateTime" },
    { "name": "modifiedAt", "type": "DateTime" }
  ],
  "methods": [
    {
      "name": "updateTimestamp",
      "returnType": "Void",
      "isAbstract": true,
      "doc": "Update the modification timestamp"
    }
  ]
}
```

**Output:**
```fantom
**
** Provides audit tracking capabilities
**
mixin Auditable
{
  DateTime createdAt
  DateTime modifiedAt

  **
  ** Update the modification timestamp
  **
  abstract Void updateTimestamp()
}
```

---

### Generate a Method

```json
{
  "type": "method",
  "name": "calculateTotal",
  "returnType": "Float",
  "isStatic": true,
  "doc": "Calculate the total price with tax",
  "params": [
    { "name": "price", "type": "Float" },
    { "name": "taxRate", "type": "Float", "default": "0.08f" }
  ],
  "body": "return price * (1f + taxRate)"
}
```

**Output:**
```fantom
**
** Calculate the total price with tax
**
static Float calculateTotal(Float price, Float taxRate := 0.08f)
{
  return price * (1f + taxRate)
}
```

---

### Generate a Complete Pod Scaffold

```json
{
  "type": "pod",
  "name": "myNewPod",
  "version": "1.0.0",
  "description": "A new Fantom pod for data processing",
  "depends": ["sys 1.0", "util 1.0", "concurrent 1.0"]
}
```

**Output:** Complete directory structure:
```
myNewPod/
├── build.fan
├── fan/
│   └── Main.fan
└── test/
    └── MainTest.fan
```

---

### Class with Facets

```json
{
  "type": "class",
  "name": "DataPoint",
  "pod": "myApp",
  "doc": "Represents a tagged data point",
  "facets": ["Serializable { simple = true }"],
  "fields": [
    { "name": "id", "type": "Str", "isFinal": true },
    { "name": "value", "type": "Float" },
    { "name": "timestamp", "type": "DateTime" }
  ]
}
```

**Output:**
```fantom
**
** Represents a tagged data point
**
@Serializable { simple = true }
class DataPoint
{
  const Str id
  Float value
  DateTime timestamp
}
```

---

### Advanced: Override Method with Validation

```json
{
  "type": "method",
  "name": "doStart",
  "returnType": "Void",
  "isOverride": true,
  "doc": "Start the service",
  "body": "super.doStart()\n    log.info(\"Service started: $name\")\n    initializeResources()"
}
```

**Output:**
```fantom
**
** Start the service
**
override Void doStart()
{
  super.doStart()
  log.info("Service started: $name")
  initializeResources()
}
```

---

## Optional Validation

Add `"validate": true` to any request to run `fan -check` on the generated code (requires Fantom installed):

```json
{
  "type": "class",
  "name": "MyClass",
  "pod": "myApp",
  "fields": [{ "name": "value", "type": "Str" }],
  "validate": true
}
```

Response will include validation results:
```json
{
  "success": true,
  "code": "...",
  "validation": {
    "valid": true,
    "errors": []
  }
}
```

---

## Running the Examples

Test all examples at once:
```bash
npm run build
node test-generate.mjs
```

Or use the MCP server directly with your AI assistant configured to use this MCP server.
