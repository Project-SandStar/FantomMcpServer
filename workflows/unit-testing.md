# Writing Unit Tests in Fantom

This guide covers writing effective unit tests for Fantom code.

## Overview

Fantom includes a built-in testing framework in the `sys` pod. Tests are:
- Easy to write
- Fast to execute
- Integrated with the build system

## Basic Test Structure

### Create a Test Class

Tests go in the `test/` directory:

```fantom
// test/MyTest.fan
using concurrent

class MyTest : Test
{
  Void testBasicAddition()
  {
    verifyEq(2 + 2, 4)
  }
  
  Void testStringConcatenation()
  {
    result := "Hello" + " " + "World"
    verifyEq(result, "Hello World")
  }
}
```

### Test Method Requirements

- Must be instance methods
- Return type must be `Void`
- Name should start with `test` (convention)
- Marked with test assertions

## Verification Methods

### Basic Assertions

```fantom
// Equality
verifyEq(actual, expected)
verifyNotEq(actual, notExpected)

// Boolean
verifyTrue(condition)
verifyFalse(condition)

// Null checks
verifyNull(obj)
verifyNotNull(obj)

// Type checks
verifyType(obj, Type#)

// Comparison
verify(actual < expected)
```

### Error/Exception Testing

```fantom
Void testException()
{
  // Verify exception is thrown
  verifyErr(ArgErr#) {
    throwArgErr()
  }
  
  // Verify specific error message
  verifyErr(ArgErr#) {
    throw ArgErr("Invalid argument")
  }
}

private Void throwArgErr()
{
  throw ArgErr("This should be caught")
}
```

### Floating Point Comparison

```fantom
Void testFloatComparison()
{
  // With tolerance
  verifyEq(1.0f / 3.0f * 3.0f, 1.0f)
  
  // Custom tolerance
  a := 1.0 / 3.0
  b := 0.333333
  verify((a - b).abs < 0.000001)
}
```

## Test Organization

### Setup and Teardown

```fantom
class DatabaseTest : Test
{
  Database? db
  
  // Run before each test
  override Void setup()
  {
    db = Database.openMemory()
  }
  
  // Run after each test
  override Void teardown()
  {
    db?.close()
    db = null
  }
  
  Void testInsert()
  {
    db.insert("key", "value")
    verifyEq(db.get("key"), "value")
  }
  
  Void testDelete()
  {
    db.insert("key", "value")
    db.delete("key")
    verifyNull(db.get("key"))
  }
}
```

### Test Suites

Group related tests in a class:

```fantom
class StringUtilsTest : Test
{
  Void testTrim()
  {
    verifyEq(StringUtils.trim("  hello  "), "hello")
  }
  
  Void testCapitalize()
  {
    verifyEq(StringUtils.capitalize("hello"), "Hello")
  }
  
  Void testReverse()
  {
    verifyEq(StringUtils.reverse("abc"), "cba")
  }
}
```

## Testing Patterns

### Testing Private Methods

Don't test private methods directly. Test them through public API:

```fantom
class Calculator
{
  Int add(Int a, Int b) { doAdd(a, b) }
  
  private Int doAdd(Int a, Int b) { a + b }
}

class CalculatorTest : Test
{
  Void testAdd()
  {
    calc := Calculator()
    // Tests doAdd indirectly
    verifyEq(calc.add(2, 3), 5)
  }
}
```

### Testing Asynchronous Code

```fantom
using concurrent

class AsyncTest : Test
{
  Void testAsyncOperation()
  {
    // Use Actor pool for async operations
    pool := ActorPool()
    future := Future.makeCompletable()
    
    // Start async work
    actor := Actor(pool) |msg| {
      future.complete("done")
    }
    actor.send("go")
    
    // Wait for completion
    result := future.get(5sec)
    verifyEq(result, "done")
    
    pool.stop.join
  }
}
```

### Testing File I/O

```fantom
class FileTest : Test
{
  File? tempFile
  
  override Void setup()
  {
    tempFile = File.createTemp("test", ".txt")
  }
  
  override Void teardown()
  {
    tempFile?.delete
  }
  
  Void testWriteAndRead()
  {
    // Write
    tempFile.out.writeChars("Hello, Fantom!").close
    
    // Read
    content := tempFile.readAllStr
    verifyEq(content, "Hello, Fantom!")
  }
}
```

### Mocking and Stubs

```fantom
// Interface for dependency
mixin Logger
{
  abstract Void log(Str msg)
}

// Mock implementation
class MockLogger : Logger
{
  Str[] messages := [,]
  
  override Void log(Str msg)
  {
    messages.add(msg)
  }
}

// System under test
class UserService
{
  Logger logger
  
  new make(Logger logger)
  {
    this.logger = logger
  }
  
  Void createUser(Str name)
  {
    logger.log("Creating user: $name")
    // ... actual creation logic
  }
}

// Test with mock
class UserServiceTest : Test
{
  Void testLogging()
  {
    mock := MockLogger()
    service := UserService(mock)
    
    service.createUser("Alice")
    
    verifyEq(mock.messages.size, 1)
    verify(mock.messages[0].contains("Alice"))
  }
}
```

## Running Tests

### From Build Script

```fantom
// build.fan
using build

class Build : BuildPod
{
  new make()
  {
    podName = "myproject"
    summary = "My project"
    version = Version("1.0")
    depends = ["sys 1.0"]
    srcDirs = [`fan/`]
    
    // Important: specify test directory
    @NoDoc Void compile() { compileFan(["src/": `fan/`, "test/": `fan/test/`]) }
  }
}
```

Run tests:

```bash
fan build.fan test
```

### From Command Line

```bash
# Run all tests in a pod
fan myproject::Test

# Run specific test class
fan myproject::MyTest

# Run with verbose output
fan -verbose myproject::Test
```

### In Development

```bash
# Watch mode (rebuild and test on changes)
while true; do
  fan build.fan test
  sleep 2
done
```

## Test Coverage

### Measuring Coverage

While Fantom doesn't have built-in coverage tools, ensure:

- All public methods have tests
- Edge cases are covered
- Error conditions are tested
- Common usage patterns are verified

### Coverage Checklist

- ✓ Normal operation
- ✓ Boundary conditions
- ✓ Invalid input
- ✓ Null handling
- ✓ Empty collections
- ✓ Error cases
- ✓ Concurrent access (if applicable)

## Best Practices

### 1. Follow Naming Conventions

```fantom
// Good
Void testCalculateTotalWithValidInput()
Void testHandleNullPointer()

// Avoid
Void test1()
Void checkStuff()
```

### 2. One Assertion Per Test (Generally)

```fantom
// Good - focused
Void testListAdd()
{
  list := [1, 2, 3]
  list.add(4)
  verifyEq(list.size, 4)
}

Void testListContains()
{
  list := [1, 2, 3]
  verifyTrue(list.contains(2))
}

// Avoid - testing too much
Void testList()
{
  list := [1, 2, 3]
  list.add(4)
  verifyEq(list.size, 4)
  verifyTrue(list.contains(2))
  verifyEq(list[0], 1)
  // ... many more assertions
}
```

### 3. Test Independence

Each test should be independent:

```fantom
// Good - tests don't depend on each other
class IndependentTest : Test
{
  Void testA()
  {
    obj := MyClass()
    obj.setValue(10)
    verifyEq(obj.getValue(), 10)
  }
  
  Void testB()
  {
    obj := MyClass()  // Fresh instance
    obj.setValue(20)
    verifyEq(obj.getValue(), 20)
  }
}
```

### 4. Use Descriptive Messages

```fantom
Void testValidation()
{
  result := validate("test@email.com")
  verify(result, "Email validation should pass for valid email")
}
```

### 5. Test Edge Cases

```fantom
Void testDivision()
{
  // Normal case
  verifyEq(10 / 2, 5)
  
  // Edge cases
  verifyEq(0 / 5, 0)
  verifyEq(5 / 1, 5)
  
  // Error case
  verifyErr(DivideByZeroErr#) { 5 / 0 }
}
```

## Example: Complete Test Class

```fantom
using concurrent

**
** Test suite for StringBuffer functionality
**
class StringBufferTest : Test
{
  StringBuffer? buf
  
  override Void setup()
  {
    buf = StringBuffer()
  }
  
  override Void teardown()
  {
    buf = null
  }
  
  Void testEmptyBuffer()
  {
    verifyEq(buf.toStr, "")
    verifyEq(buf.size, 0)
    verifyTrue(buf.isEmpty)
  }
  
  Void testAppend()
  {
    buf.add("Hello")
    verifyEq(buf.toStr, "Hello")
    verifyEq(buf.size, 5)
    verifyFalse(buf.isEmpty)
  }
  
  Void testAppendMultiple()
  {
    buf.add("Hello").add(" ").add("World")
    verifyEq(buf.toStr, "Hello World")
  }
  
  Void testClear()
  {
    buf.add("Test")
    buf.clear
    verifyEq(buf.toStr, "")
    verifyTrue(buf.isEmpty)
  }
  
  Void testCapacity()
  {
    initial := buf.capacity
    verify(initial > 0)
    
    // Add beyond capacity
    100.times { buf.add("x") }
    verify(buf.capacity >= initial)
  }
}
```

## Common Testing Mistakes

### 1. Testing Implementation Details

❌ **Bad:**
```fantom
Void testInternalState()
{
  obj := MyClass()
  verifyNotNull(obj.internalCache)  // Testing private state
}
```

✓ **Good:**
```fantom
Void testBehavior()
{
  obj := MyClass()
  result := obj.doSomething()
  verifyEq(result, expected)  // Testing behavior
}
```

### 2. Fragile Tests

❌ **Bad:**
```fantom
Void testOutput()
{
  verifyEq(obj.toString, "User[id=1,name=Alice,created=2024-01-01]")
}
```

✓ **Good:**
```fantom
Void testOutput()
{
  str := obj.toString
  verify(str.contains("Alice"))
  verify(str.contains("id=1"))
}
```

### 3. No Teardown

❌ **Bad:**
```fantom
Void testFileWrite()
{
  f := File(`test.txt`)
  f.out.writeChars("test").close
  // File left behind!
}
```

✓ **Good:**
```fantom
File? f
override Void teardown() { f?.delete }

Void testFileWrite()
{
  f = File.createTemp()
  f.out.writeChars("test").close
  verifyEq(f.readAllStr, "test")
}
```

## Next Steps

- Write tests for existing code
- Practice TDD (Test-Driven Development)
- Set up continuous integration
- Explore property-based testing
- Integrate with build automation

## Resources

- Fantom Test API: https://fantom.org/doc/sys/Test
- Testing best practices
- TDD methodologies
- Mocking frameworks
