# Using fanr - Fantom Repository Manager

This guide covers using `fanr` to publish and manage Fantom pods.

## What is fanr?

`fanr` is Fantom's repository manager, similar to npm, Maven, or pip. It allows you to:

- Publish pods to repositories
- Install pods from repositories
- Query available pods
- Manage pod versions

## Prerequisites

- Fantom runtime installed
- `fanr` command available
- Network access (for remote repositories)

## Repository Types

### Local Repository

Default location: `FAN_HOME/lib/fan/`

### Remote Repository

HTTP/HTTPS-based repository (e.g., Eggbox)

### File Repository

File system-based repository

## Basic Commands

### Query Pods

List all available pods:

```bash
fanr query
```

Search for specific pods:

```bash
fanr query "web*"
```

Show pod details:

```bash
fanr query inet
```

### Install Pods

Install a pod:

```bash
fanr install inet
```

Install specific version:

```bash
fanr install inet@1.0.67
```

Install multiple pods:

```bash
fanr install inet,concurrent,util
```

### Publish Pods

Publish your pod to a repository:

```bash
fanr publish myproject.pod -r http://repo.example.com/fanr/
```

Publish with credentials:

```bash
fanr publish myproject.pod -r http://repo.example.com/fanr/ -u username -p password
```

## Configuration

### fanr.props

Create a `fanr.props` file for default settings:

```properties
# Default repository
repo=http://eggbox.fantomfactory.org/fanr/

# Credentials (use environment variables for security)
username=${FANR_USER}
password=${FANR_PASS}
```

### Environment Variables

```bash
export FANR_REPO=http://eggbox.fantomfactory.org/fanr/
export FANR_USER=myusername
export FANR_PASS=mypassword
```

## Publishing Workflow

### 1. Prepare Your Pod

Ensure your `build.fan` has complete metadata:

```fantom
using build

class Build : BuildPod
{
  new make()
  {
    podName = "myproject"
    summary = "Comprehensive summary of your pod"
    version = Version("1.0.0")
    meta = [
      "org.name":     "My Organization",
      "org.uri":      "https://myorg.com/",
      "proj.name":    "My Project",
      "proj.uri":     "https://github.com/myorg/myproject",
      "license.name": "Apache License 2.0",
      "vcs.name":     "Git",
      "vcs.uri":      "https://github.com/myorg/myproject"
    ]
    depends = [
      "sys 1.0",
      "concurrent 1.0"
    ]
    srcDirs = [`fan/`]
  }
}
```

### 2. Build the Pod

```bash
fan build.fan
```

### 3. Test the Pod

```bash
fan build.fan test
```

### 4. Publish

```bash
fanr publish fan/myproject.pod
```

## Advanced Usage

### Local Repository

Create a local repository:

```bash
mkdir -p ~/fanr-repo
fanr publish myproject.pod -r file://~/fanr-repo/
```

Use local repository:

```bash
fanr install myproject -r file://~/fanr-repo/
```

### Version Management

Install latest version:

```bash
fanr install myproject
```

Install specific version:

```bash
fanr install myproject@1.0.0
```

Install version range:

```bash
fanr install myproject@1.x
```

### Dependency Resolution

fanr automatically resolves and installs dependencies:

```bash
fanr install web
# Also installs: sys, concurrent, inet, util, etc.
```

### Private Repositories

Set up authentication:

```bash
fanr publish myproject.pod \
  -r https://private-repo.company.com/fanr/ \
  -u username \
  -p password
```

Or use `.netrc` file:

```
machine private-repo.company.com
login username
password mypassword
```

## Common Repository URLs

### Eggbox (Official Repository)

```
http://eggbox.fantomfactory.org/fanr/
```

### Local Development

```
file:///path/to/local/repo/
```

## Build Script Integration

Integrate fanr publishing into your build script:

```fantom
using build

class Build : BuildPod
{
  new make()
  {
    podName = "myproject"
    summary = "My project"
    version = Version("1.0.0")
    depends = ["sys 1.0"]
    srcDirs = [`fan/`]
  }

  @Target { help = "Publish pod to repository" }
  Void publish()
  {
    // Build first
    compile

    // Publish
    repo := Env.cur.vars["FANR_REPO"] ?: "http://eggbox.fantomfactory.org/fanr/"
    cmd := "fanr publish ${outPodDir.uri}${podName}.pod -r ${repo}"
    
    log.info("Publishing to $repo...")
    Process([cmd]).run.join
    log.info("Published successfully!")
  }
}
```

Run with:

```bash
fan build.fan publish
```

## Pod Metadata Best Practices

### Required Metadata

- `podName` - Unique identifier
- `summary` - Clear, concise description
- `version` - Semantic versioning
- `depends` - All dependencies with versions

### Recommended Metadata

- `org.name` - Organization name
- `org.uri` - Organization website
- `proj.uri` - Project homepage/repository
- `license.name` - License type
- `vcs.uri` - Source control URL

### Example Complete Metadata

```fantom
meta = [
  "org.name":     "Acme Corp",
  "org.uri":      "https://acme.com/",
  "proj.name":    "Widget Framework",
  "proj.uri":     "https://github.com/acme/widgets",
  "license.name": "MIT",
  "vcs.name":     "Git",
  "vcs.uri":      "https://github.com/acme/widgets.git",
  "repo.public":  "true",
  "repo.tags":    "widgets,ui,framework"
]
```

## Troubleshooting

### "Unauthorized" error

Check credentials:
- Verify username/password
- Check repository permissions
- Ensure account is active

### "Pod already exists" error

You're trying to publish an existing version:
- Increment version number
- Or force republish (if supported)

### "Dependency not found" error

Missing dependency:
- Install dependency first
- Or publish to same repository
- Check dependency version compatibility

### Network errors

Check connectivity:
- Verify repository URL
- Check firewall settings
- Try alternative repository mirror

## Next Steps

- Learn about pod structure ([Create Fantom Pod](workflow://create-pod))
- Set up automated publishing in CI/CD
- Create your own private repository
- Explore dependency management strategies

## Resources

- Official fanr documentation: https://fantom.org/doc/docFanr/index
- Eggbox repository: http://eggbox.fantomfactory.org/
- Fantom community forums
