tes# Code Generation Tools

Tools for generating Fantom code structures - classes, methods, pods, enums, and more.

## Tools

### gen_class
Generate a Fantom class definition.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | Yes | Class name |
| pod | string | No | Pod name |
| extends | string | No | Parent class (default: Obj) |
| mixins | string[] | No | Mixin implementations |
| fields | object[] | No | Field definitions |
| methods | object[] | No | Method definitions |
| abstract | boolean | No | Abstract class |
| const | boolean | No | Const class |

**Example:**
```json
{
  "name": "UserService",
  "pod": "myApp",
  "extends": "Service",
  "fields": [
    { "name": "db", "type": "Database", "const": true }
  ],
  "methods": [
    { "name": "findUser", "params": [{"name": "id", "type": "Int"}], "returns": "User?" }
  ]
}
```

---

### gen_method
Generate a Fantom method definition.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | Yes | Method name |
| params | object[] | No | Parameter definitions |
| returns | string | No | Return type |
| body | string | No | Method body |
| static | boolean | No | Static method |
| virtual | boolean | No | Virtual method |
| override | boolean | No | Override method |

**Example:**
```json
{
  "name": "calculate",
  "params": [
    { "name": "a", "type": "Int" },
    { "name": "b", "type": "Int" }
  ],
  "returns": "Int",
  "body": "return a + b"
}
```

---

### gen_pod
Generate a complete pod structure with build.fan.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | Yes | Pod name |
| version | string | No | Version string |
| summary | string | No | Pod description |
| depends | string[] | No | Dependencies |
| srcDirs | string[] | No | Source directories |

**Example:**
```json
{
  "name": "myPod",
  "version": "1.0.0",
  "summary": "My awesome pod",
  "depends": ["sys 1.0", "util 1.0"]
}
```

---

### gen_enum
Generate a Fantom enum definition.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | Yes | Enum name |
| values | string[] | Yes | Enum values |
| pod | string | No | Pod name |

**Example:**
```json
{
  "name": "Status",
  "values": ["pending", "active", "completed", "cancelled"],
  "pod": "myApp"
}
```

---

### gen_mixin
Generate a Fantom mixin definition.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | Yes | Mixin name |
| methods | object[] | No | Method signatures |
| pod | string | No | Pod name |

**Example:**
```json
{
  "name": "Serializable",
  "methods": [
    { "name": "toJson", "returns": "Str", "abstract": true },
    { "name": "fromJson", "params": [{"name": "json", "type": "Str"}], "static": true }
  ]
}
```

---

### gen_test
Generate a Fantom test class.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | Yes | Test class name |
| targetClass | string | No | Class being tested |
| testMethods | string[] | No | Test method names |

**Example:**
```json
{
  "name": "UserServiceTest",
  "targetClass": "UserService",
  "testMethods": ["testCreate", "testFind", "testDelete"]
}
```

---

### gen_buildFile
Generate a build.fan file for a pod.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| podName | string | Yes | Pod name |
| version | string | No | Version |
| depends | string[] | No | Dependencies |
| srcDirs | string[] | No | Source directories |

**Example:**
```json
{
  "podName": "myPod",
  "version": "1.0.0",
  "depends": ["sys 1.0", "concurrent 1.0"],
  "srcDirs": ["fan", "test"]
}
```

---

### gen_validateCode
Validate generated Fantom code for syntax and basic semantics.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| code | string | Yes | Fantom code to validate |
| strict | boolean | No | Enable strict validation |

**Example:**
```json
{
  "code": "class Foo { Int bar() { return 42 } }",
  "strict": true
}
```

---

## Test Results

| Tool | Status | Notes |
|------|--------|-------|
| gen_class | - | - |
| gen_method | - | - |
| gen_pod | - | - |
| gen_enum | - | - |
| gen_mixin | - | - |
| gen_test | - | - |
| gen_buildFile | - | - |
| gen_validateCode | - | - |
