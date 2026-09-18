# SkySpark 4.x Automated Migration Tool - Usage Guide

## Overview

The MCP Fantom Server now includes a powerful automated migration tool that can convert SkySpark 3.x projects to 4.0 with minimal manual intervention.

## MCP Tools Available

### 1. `migrateSkySpark4x` - Main Migration Tool

Automatically migrates a SkySpark 3.x project from GitLab to 4.0.

**What it does:**
1. Clones the GitLab repository (uses your SSH keys)
2. Creates backup tag `pre-migration-backup`
3. Creates and switches to `4.0.3` branch
4. Analyzes project structure
5. Transforms all `.fan` files:
   - `using skyarcd` → `using hx`
   - `@Axon` → `@Api`
   - `FooLib` → `FooExt`
   - `libs.get()` → `exts.get()`
   - Adds `Context cx` parameter to @Api methods
   - Updates extension names to dotted format
6. Creates `lib/` directory structure
7. Generates `lib.trio` (metadata)
8. Generates `funcs.xeto` (function specs)
9. Generates `lib.xeto` (type specs)
10. Updates or creates `buildLocal.fan`
11. Validates compilation using SkySpark fan compiler
12. Returns detailed report for review

**Parameters:**
```json
{
  "gitlabUrl": "git@gitlab.com:yourorg/project.git",
  "projectName": "myproject",
  "workDir": "/path/to/workspace",
  "skysparkBinPath": "/Users/apple/Downloads/skyspark-4.0.3/bin",
  "dryRun": false
}
```

**Example Usage in Claude:**
```
Migrate my SkySpark project:
- GitLab URL: git@gitlab.com:akbin/hvac-connector.git
- Project name: hvacConn
- Work directory: /Users/apple/Projects
- SkySpark bin: /Users/apple/Downloads/skyspark-4.0.3/bin
```

### 2. `commitMigration` - Commit Changes

After reviewing the migration results, commit and push to GitLab.

**What it does:**
1. Stages all changes
2. Commits with descriptive message
3. Safety check (refuses to push to main)
4. Pushes to `origin/4.0.3` branch

**Parameters:**
```json
{
  "projectPath": "/Users/apple/Projects/hvacConn"
}
```

**Example Usage:**
```
Commit the migration for /Users/apple/Projects/hvacConn
```

### 3. `rollbackMigration` - Undo Changes

If something went wrong, rollback to pre-migration state.

**What it does:**
1. Resets to `pre-migration-backup` tag
2. Returns to main branch
3. Leaves no trace of migration attempt

**Parameters:**
```json
{
  "projectPath": "/Users/apple/Projects/hvacConn"
}
```

**Example Usage:**
```
Rollback the migration for /Users/apple/Projects/hvacConn
```

## Complete Migration Workflow

### Step 1: Prepare

**Prerequisites:**
- SSH access to GitLab configured
- SkySpark 4.0.3 installed locally
- Workspace directory for cloning

**Get paths:**
```bash
# Find SkySpark bin path
ls /Users/apple/Downloads/skyspark-4.0.3/bin/fan

# Create workspace
mkdir -p /Users/apple/Projects/migrations
```

### Step 2: Run Migration

**Ask Claude (or other AI with MCP):**
```
Migrate my SkySpark extension from 3.x to 4.0:
- GitLab URL: git@gitlab.com:akbin/my-connector.git
- Project: myConn
- Workspace: /Users/apple/Projects/migrations
- SkySpark: /Users/apple/Downloads/skyspark-4.0.3/bin
```

**AI will:**
1. Call `migrateSkySpark4x` tool
2. Show you detailed results:
   - Files changed
   - Files created
   - Compilation status
   - Errors/warnings
   - Migration summary

### Step 3: Review Changes

**Check the migration:**
```bash
cd /Users/apple/Projects/migrations/myConn
git diff main..4.0.3
```

**Review generated files:**
- `lib/lib.trio` - Metadata
- `lib/funcs.xeto` - Function specs
- `lib/lib.xeto` - Type specs
- `buildLocal.fan` - Updated build file

**Test compilation:**
```bash
/Users/apple/Downloads/skyspark-4.0.3/bin/fan buildLocal.fan
```

### Step 4: Approve or Rollback

**If satisfied, commit:**
```
Commit the migration for /Users/apple/Projects/migrations/myConn
```

**If issues found, rollback:**
```
Rollback the migration for /Users/apple/Projects/migrations/myConn
```

Then fix issues manually and try again.

### Step 5: Create Merge Request

After successful commit:

1. Go to GitLab project
2. Create merge request: `4.0.3` → `main`
3. Review with team
4. Merge when approved

## What Gets Transformed

### Code Transformations

#### 1. Using Statements
```fantom
// Before
using skyarcd

// After
using hx
```

#### 2. Facets
```fantom
// Before
@Axon static Str doSomething(Str arg) { ... }

// After
@Api static Str doSomething(Context cx, Str arg) { ... }
```

#### 3. Class Names
```fantom
// Before
class MyConnLib : Ext { ... }

// After
class MyConnExt : Ext { ... }
```

#### 4. API Calls
```fantom
// Before
Proj.cur.libs.get("modbus")

// After
Proj.cur.exts.get("hx.modbus")
```

#### 5. Extension Names
```fantom
// Before
exts.get("task")

// After
exts.get("hx.task")
```

#### 6. Test Classes
```fantom
// Before
class MyTest : ProjTest { ... }

// After
class MyTest : HxTest { ... }
```

### File Structure Changes

#### Before (3.x)
```
myConn/
  buildLocal.fan
  fan/
    MyConnLib.fan
```

#### After (4.0)
```
myConn/
  buildLocal.fan         (updated)
  fan/
    MyConnExt.fan        (transformed)
  lib/                   (NEW)
    lib.trio             (NEW)
    lib.xeto             (NEW)
    funcs.xeto           (NEW)
```

### buildLocal.fan Changes

#### Before
```fantom
using build

class Build : BuildPod {
  new make() {
    podName = "myConn"
    version = Version("3.1.0")
    depends = ["sys 1.0", "skyarcd 3.1"]
    srcDirs = [`fan/`]
    index = [
      "ext.name": "myConn",
      "ext.icon": "cog"
    ]
  }
}
```

#### After
```fantom
using build

class Build : BuildPod {
  new make() {
    podName = "myConn"
    version = Version("4.0.0")
    depends = ["sys 1.0", "hx 4.0"]
    srcDirs = [`fan/`]
    resDirs = [`lib/`]
    index = [
      "ph.lib": "akbin.myConn",
      "xeto.bindings": "akbin.myConn"
    ]
  }
}
```

## Generated Files

### lib.trio
```trio
dis: "My Connector"
version: "4.0.0"
icon: "cog"
doc: "Migrated to SkySpark 4.0"

depends: [
  {lib: "sys"},
  {lib: "ph"},
  {lib: "hx"}
]

org: {
  dis: "AKBIN"
  uri: "https://akbin.com"
}
```

### funcs.xeto
```xeto
// Axon functions

myFunc: Func {
  doc: "My function"
  arg1: Str
  arg2: Number?
  returns: Dict
}
```

### lib.xeto
```xeto
// Xeto specifications for myConn

// Add custom type specs here as needed
```

## Common Issues & Solutions

### Issue: Compilation Fails

**Symptom:** `compilationSuccess: false` with errors

**Solutions:**
1. Review error messages in migration result
2. Common issues:
   - Missing dependencies in `depends`
   - Type mismatches in function signatures
   - Namespace conflicts
3. Fix manually and recompile
4. Commit if successful, or rollback and re-run

### Issue: SSH Permission Denied

**Symptom:** Git clone fails with "Permission denied"

**Solutions:**
1. Ensure SSH keys added to GitLab
2. Test: `ssh -T git@gitlab.com`
3. Add SSH key if needed:
   ```bash
   ssh-keygen -t ed25519 -C "your@email.com"
   cat ~/.ssh/id_ed25519.pub
   # Add to GitLab → Settings → SSH Keys
   ```

### Issue: SkySpark bin Path Invalid

**Symptom:** Compilation step fails with "command not found"

**Solutions:**
1. Verify path exists:
   ```bash
   ls /Users/apple/Downloads/skyspark-4.0.3/bin/fan
   ```
2. Use full absolute path
3. Ensure SkySpark 4.0.3 is properly installed

### Issue: Function Parameters Wrong

**Symptom:** @Api functions missing Context parameter

**Solutions:**
- Tool attempts to add `Context cx` automatically
- May need manual adjustment for complex signatures
- Check generated code and fix if needed

### Issue: Extension Names Not Dotted

**Symptom:** Some `exts.get()` calls still use simple names

**Solutions:**
- Tool adds `hx.` prefix automatically
- Custom extensions may need manual `akbin.` prefix
- Review and fix extension lookup calls

## Advanced Usage

### Dry Run Mode

Preview changes without committing:

```json
{
  "gitlabUrl": "git@gitlab.com:akbin/test.git",
  "projectName": "test",
  "workDir": "/tmp/preview",
  "skysparkBinPath": "/path/to/bin",
  "dryRun": true
}
```

Changes are made but not committed. Review and delete.

### Batch Migration

Migrate multiple projects:

```
Migrate these SkySpark projects to 4.0:
1. git@gitlab.com:akbin/hvac.git
2. git@gitlab.com:akbin/lighting.git
3. git@gitlab.com:akbin/meters.git

Use workspace /Users/apple/Projects/batch
Use SkySpark /Users/apple/Downloads/skyspark-4.0.3/bin
```

AI will migrate each one sequentially.

### Manual Fix Workflow

If automatic migration needs tweaks:

1. Run migration (gets you 90% there)
2. Review compilation errors
3. Fix issues manually in project directory
4. Test: `fan buildLocal.fan`
5. When successful, commit manually:
   ```bash
   cd /path/to/project
   git add .
   git commit -m "Migrate to 4.0 (with manual fixes)"
   git push origin 4.0.3
   ```

## Safety Features

### 1. Backup Tag
- Creates `pre-migration-backup` tag before any changes
- Can always rollback: `git reset --hard pre-migration-backup`

### 2. Branch Protection
- Always works on `4.0.3` branch
- Never touches `main` branch
- Refuses to push to main

### 3. Non-Destructive
- Original repository unchanged until you merge
- Can delete branch and try again
- No data loss risk

### 4. Compilation Validation
- Tests build before presenting results
- Shows errors immediately
- No blind commits

## Tips for Success

### 1. Start Small
- Test on simple extension first
- Learn the process
- Then tackle complex projects

### 2. Review Thoroughly
- Check all transformed files
- Verify function signatures
- Test compilation locally

### 3. Use Version Control
- Migration creates clean history
- Easy to see what changed
- Can cherry-pick fixes if needed

### 4. Incremental Approach
- Migrate one extension at a time
- Test each one independently
- Build confidence gradually

### 5. Keep Documentation
- Update README with 4.0 notes
- Document any manual changes
- Help team understand migration

## What to Check After Migration

### ✅ Checklist

- [ ] All `.fan` files use `using hx`
- [ ] No `@Axon` facets remaining
- [ ] All @Api methods have `Context cx` parameter
- [ ] `buildLocal.fan` has `ph.lib` and `xeto.bindings`
- [ ] `lib/lib.trio` has correct metadata
- [ ] `lib/funcs.xeto` has all functions
- [ ] Extension names use `akbin.` prefix
- [ ] Compilation succeeds without errors
- [ ] No 3.x API calls remaining
- [ ] Tests pass (if you have tests)

### 🔍 Manual Review Points

1. **Custom Types:** May need Xeto specs in `lib.xeto`
2. **Settings:** Check if settings schema needed
3. **Dependencies:** Verify all deps are 4.0 compatible
4. **Connectors:** Check model name inference
5. **Complex Functions:** Verify parameter types correct

## Getting Help

If migration fails or needs manual intervention:

**Ask AI:**
```
The migration had these errors: [paste errors]
How should I fix them?
```

**Resources:**
- `workflow://skyspark-4x-migration` - Full migration guide
- `workflow://api-migration-reference` - API mappings
- `workflow://xeto-spec-guide` - Xeto specifications
- SkySpark forum - Community help
- Email: support@skyfoundry.com

## Summary

The automated migration tool provides:

✅ **Fast**: Migrates project in minutes
✅ **Safe**: Backup tags, branch protection, no data loss
✅ **Smart**: Detects patterns, generates Xeto specs
✅ **Validated**: Tests compilation before presenting
✅ **Flexible**: Review before commit, rollback if needed

**Ready to migrate your SkySpark 3.x projects to 4.0!** 🚀
