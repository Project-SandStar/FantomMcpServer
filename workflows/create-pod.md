# Creating a Fantom Pod

This guide walks you through creating a new Fantom pod from scratch.

## What is a Pod?

A pod is Fantom's unit of deployment and versioning. It's similar to a JAR file in Java or a package in other languages. A pod contains:

- Compiled Fantom code (.class files)
- Resource files
- Metadata (pod.meta)
- Dependencies information

## Prerequisites

- Fantom runtime installed
- `fan` command available in PATH
- Text editor

## Step 1: Create Pod Directory Structure

Create a new directory for your pod:

```bash
mkdir myproject
cd myproject
```

Create the standard pod structure:

```bash
mkdir -p fan src test
```

- `fan/` - Output directory for compiled pod
- `src/` - Source code directory
- `test/` - Unit tests directory

## Step 2: Create build.fan

Create a `build.fan` file in the root directory:

```fantom
using build

class Build : BuildPod
{
  new make()
  {
    podName = "myproject"
    summary = "My Fantom project"
    version = Version("1.0.0")
    meta = [
      "org.name":     "My Organization",
      "org.uri":      "https://myorg.com/",
      "license.name": "Apache License 2.0",
      "vcs.name":     "Git",
      "vcs.uri":      "https://github.com/myorg/myproject"
    ]
    depends = [
      "sys 1.0",
      "concurrent 1.0"
    ]
    srcDirs = [`fan/`]
    resDirs = [,]
  }
}
```

## Step 3: Write Your First Class

Create a file `src/Main.fan`:

```fantom
class Main
{
  static Void main()
  {
    echo("Hello from myproject!")
  }
}
```

## Step 4: Build the Pod

Build your pod:

```bash
fan build.fan
```

This compiles your source code and creates the pod in the `fan/` directory.

## Step 5: Run Your Code

Execute the main method:

```bash
fan myproject::Main
```

Or if you want to run from the compiled pod:

```bash
fan fan/myproject.pod Main
```

## Pod Metadata

The `build.fan` file contains important metadata:

- **podName**: Unique identifier for your pod
- **summary**: Short description
- **version**: Semantic version (major.minor.patch)
- **meta**: Additional metadata (organization, license, etc.)
- **depends**: List of pod dependencies
- **srcDirs**: Source code directories
- **resDirs**: Resource directories

## Dependencies

Specify dependencies in the `depends` list:

```fantom
depends = [
  "sys 1.0",           // System pod (always required)
  "concurrent 1.0",    // Concurrency utilities
  "inet 1.0",          // Networking
  "util 1.0",          // Utility classes
  "web 1.0"            // Web framework
]
```

## Adding Resources

To include resource files:

1. Create a `res/` directory
2. Add files to `res/`
3. Update `build.fan`:

```fantom
resDirs = [`res/`]
```

Access resources in code:

```fantom
pod := Pod.of(this)
file := pod.file(`/res/config.txt`)
content := file.readAllStr
```

## Common Build Tasks

```bash
# Build pod
fan build.fan

# Clean build artifacts
fan build.fan clean

# Full rebuild
fan build.fan full

# Run tests
fan build.fan test
```

## Next Steps

- Add unit tests (see [Writing Unit Tests](workflow://unit-testing))
- Publish your pod (see [Using fanr](workflow://use-fanr))
- Learn about Haxall integration (see [Haxall Basics](workflow://haxall-basics))

## Best Practices

1. **Use semantic versioning** - Follow MAJOR.MINOR.PATCH
2. **Document your API** - Use Fandoc comments
3. **Write tests** - Add unit tests for all public APIs
4. **Minimize dependencies** - Only depend on what you need
5. **Follow naming conventions** - Use UpperCamelCase for types, lowerCamelCase for methods

## Common Issues

### "Pod not found" error

Make sure your pod is in Fantom's path:
- Add to `FAN_HOME/lib/fan/`
- Or use `fanr` to install
- Or specify full path to .pod file

### Build fails with dependency errors

Check that all dependencies:
- Are installed in your Fantom environment
- Have compatible versions
- Are spelled correctly in `depends` list

### Class not found at runtime

Ensure:
- Class is in `src/` directory
- File name matches class name
- Pod was rebuilt after changes
