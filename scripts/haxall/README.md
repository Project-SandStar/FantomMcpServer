# Haxall builds

`build.sh` compiles one Haxall source release and installs a runtime into
`haxall-<version>/home` (`bin/ doc/ etc/ lib/fan lib/java lib/xeto`). It is a
runtime, not a Fantom source tree. The Fantom MCP server runs this script for
the dashboard buttons "Check & add Haxall" and "Compile home"; it passes every
path in the environment (Settings > Installer sources).

| Haxall | Fantom |
| --- | --- |
| 4.0.6 | 1.0.83 |
| 4.0.7 | 1.0.84 |

Pairings are in `versions.txt`. The server also has its own table in settings;
without a row there it takes the newest Fantom release published on or before
the Haxall release.

## Paths

Set them in the environment or in `build.env` (copy `build.env.example`).
A value in the environment wins.

| Name | Meaning |
| --- | --- |
| `HAXALL_ROOT` | holds `haxall-<version>/` source trees |
| `FANTOM_ROOT` | holds `fantom-<version>/` releases |
| `HAYSTACK_DIR` | haystack-defs checkout (its `lib/fan` pods are copied as they are) |
| `XETO_DIR` | Xeto checkout; the directory must be named `xeto` |
| `XETO_REPO` | optional; a worktree is made from it when `XETO_DIR` is missing |
| `JDK_HOME` | JDK 17; else `/usr/libexec/java_home -v 17`, else `JAVA_HOME` |

## Run

```bash
./build.sh 4.0.7
./build.sh 4.0.8 --fantom 1.0.85 --fetch --xeto-rev <commit>
```

`--fetch` downloads `https://github.com/haxall/haxall/archive/refs/tags/v<version>.tar.gz`
when `haxall-<version>/src` is missing. `--xeto-rev` detaches the Xeto checkout
at that commit and refuses to run if it is dirty.

## What it does

- Writes `fan.props` in the source tree: `path=<haystack-defs>;<xeto>`.
- Runs `fan src/build.fan clean compile`, then the `xeto` target, with JDK 17
  and `FAN_BUILD_JDKHOME`.
- Replaces `home/` with Fantom `bin`, `etc`, `sys.jar`, plus the Haxall,
  Haystack and Xeto libraries. Test and doc pods are left out.
- Generates docs from the source directory (so `fan.props` is on the path):
  `home/bin/fan compilerDoc -all` and `home/bin/xeto doc-html -all`.

`fan -version` exits 3 even when it works. Do not chain a build on it.
