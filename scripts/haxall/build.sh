#!/usr/bin/env bash
# Build a Haxall source tree into haxall-<version>/home.
# The home directory matches haxall-4.0.6/home:
#   bin/  doc/  etc/  lib/fan  lib/java  lib/xeto
# It is a runtime, not a Fantom source checkout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
# Settings come from the environment first, then from BUILD_ENV (default
# ./build.env, optional). A value already in the environment always wins:
# the Fantom MCP server passes every path this way.
ENV_FILE="${BUILD_ENV:-$ROOT/build.env}"
VERSIONS_FILE="${VERSIONS_FILE:-$ROOT/versions.txt}"

usage() {
  cat <<EOF
Usage: $(basename "$0") <haxall-version> [options]

Compile \$HAXALL_ROOT/haxall-<version> and install a runtime into its home/ directory.
Fantom releases live in \$FANTOM_ROOT/fantom-<ver>. Each Haxall version gets its own copy.
Paths: HAXALL_ROOT FANTOM_ROOT HAYSTACK_DIR XETO_DIR XETO_REPO JDK_HOME JDK_VERSION
(environment, or BUILD_ENV / build.env next to this script).

Options:
  --fantom <ver>     Fantom release to copy, for example 1.0.85.
                     Required when <version> is not listed in versions.txt.
  --xeto <dir>       Xeto checkout. The directory name must be "xeto".
  --xeto-rev <rev>   Detach that checkout at <rev> before building.
  --jdk <ver>        JDK major version used to compile (default 17).
  --fetch            Download the GitHub source archive if the tree is missing.
  --no-doc           Skip compilerDoc and xeto doc-html.
  -h, --help         Show this help.

Examples:
  $(basename "$0") 4.0.7
  $(basename "$0") 4.0.8 --fantom 1.0.85 --fetch
EOF
}

die() { echo "ERROR: $*" >&2; exit 1; }

VERSION=""
FANTOM_VER_FLAG=""
XETO_DIR_FLAG=""
XETO_REV=""
JDK_FLAG=""
FETCH=0
DOCS=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --fantom) FANTOM_VER_FLAG="${2:-}"; shift 2 ;;
    --xeto) XETO_DIR_FLAG="${2:-}"; shift 2 ;;
    --xeto-rev) XETO_REV="${2:-}"; shift 2 ;;
    --jdk) JDK_FLAG="${2:-}"; shift 2 ;;
    --fetch) FETCH=1; shift ;;
    --no-doc) DOCS=0; shift ;;
    -*) die "unknown option: $1" ;;
    *)
      [[ -z "$VERSION" ]] || die "unexpected argument: $1"
      VERSION="$1"
      shift
      ;;
  esac
done

[[ -n "$VERSION" ]] || { usage; exit 1; }
# Load KEY=VALUE lines from the env file, but never over a value that is
# already set in the environment.
if [[ -f "$ENV_FILE" ]]; then
  while IFS= read -r line || [[ -n "${line:-}" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
    [[ -n "${!key:-}" ]] || export "$key=$val"
  done < "$ENV_FILE"
fi

HAXALL_ROOT="${HAXALL_ROOT:-$ROOT}"
[[ -n "${FANTOM_ROOT:-}" ]] || die "FANTOM_ROOT is not set"
[[ -n "${HAYSTACK_DIR:-}" ]] || die "HAYSTACK_DIR is not set"
XETO_DIR="${XETO_DIR_FLAG:-${XETO_DIR:-$HAXALL_ROOT/xeto}}"
XETO_REPO="${XETO_REPO:-}"
JDK_VERSION="${JDK_FLAG:-${JDK_VERSION:-17}}"

lookup_fantom() {
  local ver="$1" line hx fan
  while read -r line || [[ -n "${line:-}" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// }" ]] && continue
    read -r hx fan <<<"$line"
    if [[ "$hx" == "$ver" ]]; then
      echo "$fan"
      return 0
    fi
  done < "$VERSIONS_FILE"
  return 1
}

if [[ -n "$FANTOM_VER_FLAG" ]]; then
  FANTOM_VER="$FANTOM_VER_FLAG"
else
  FANTOM_VER=""
  if [[ -f "$VERSIONS_FILE" ]]; then FANTOM_VER="$(lookup_fantom "$VERSION" || true)"; fi
fi
[[ -n "${FANTOM_VER:-}" ]] || die "no Fantom version for Haxall $VERSION. Pass --fantom and add a line to versions.txt"

SRC="$HAXALL_ROOT/haxall-$VERSION"
FANTOM="$FANTOM_ROOT/fantom-$FANTOM_VER"
HOME_DIR="$SRC/home"

[[ "$(basename "$XETO_DIR")" == "xeto" ]] || die "Xeto directory must be named xeto (got $(basename "$XETO_DIR")). The build looks up that path entry by name."
[[ -d "$HAYSTACK_DIR" ]] || die "haystack-defs not found: $HAYSTACK_DIR"
[[ -d "$FANTOM" ]] || die "Fantom release not found: $FANTOM"
[[ -x "$FANTOM/bin/fan" ]] || die "not a Fantom home: $FANTOM"

if [[ ! -d "$SRC/src" ]]; then
  if [[ "$FETCH" -eq 1 ]]; then
    echo "Downloading Haxall $VERSION source..."
    tmp="$(mktemp -d)"
    curl -fsSL "https://github.com/haxall/haxall/archive/refs/tags/v${VERSION}.tar.gz" -o "$tmp/src.tar.gz"
    tar -xzf "$tmp/src.tar.gz" -C "$tmp"
    extracted="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)"
    [[ -n "$extracted" && -d "$extracted/src" ]] || die "downloaded archive has no src/"
    rm -rf "$SRC"
    mv "$extracted" "$SRC"
    rm -rf "$tmp"
  else
    die "source tree not found: $SRC (pass --fetch to download v$VERSION)"
  fi
fi

if [[ ! -d "$XETO_DIR" ]]; then
  [[ -n "$XETO_REPO" && -d "$XETO_REPO/.git" ]] || die "xeto checkout not found: $XETO_DIR"
  echo "Creating xeto worktree at $XETO_DIR"
  git -C "$XETO_REPO" worktree add --detach "$XETO_DIR" HEAD
fi

if [[ -n "$XETO_REV" ]]; then
  git -C "$XETO_DIR" diff --quiet && git -C "$XETO_DIR" diff --cached --quiet \
    || die "xeto checkout is dirty; not checking out $XETO_REV"
  git -C "$XETO_DIR" checkout --detach "$XETO_REV"
fi

if [[ -n "${JDK_HOME:-}" ]]; then
  :
elif [[ -x /usr/libexec/java_home ]]; then
  JDK_HOME="$(/usr/libexec/java_home -v "$JDK_VERSION")"
else
  JDK_HOME="${JAVA_HOME:-}"
fi
[[ -n "${JDK_HOME:-}" && -d "$JDK_HOME" ]] || die "JDK $JDK_VERSION not found"

# Pods the official dist does not ship. See src/build.fan distPod.
skip_pod() {
  local name="$1"
  case "$name" in
    test*|doc[A-Z]*|flux|fluxText|fwt|gfx|icons|webfwt) return 0 ;;
    *) return 1 ;;
  esac
}

echo "Haxall:  $SRC"
echo "Fantom:  $FANTOM"
echo "Xeto:    $XETO_DIR"
echo "JDK:     $JDK_HOME"
echo "Home:    $HOME_DIR"

printf 'path=%s;%s\n' "$HAYSTACK_DIR" "$XETO_DIR" > "$SRC/fan.props"

export FAN_HOME="$FANTOM"
export JAVA_HOME="$JDK_HOME"
export FAN_BUILD_JDKHOME="${JDK_HOME%/}/"
export PATH="$FANTOM/bin:$PATH"

cd "$SRC"
# fan -version exits 3 even when it prints successfully. Do not chain on it.
"$FANTOM/bin/fan" src/build.fan clean compile
"$FANTOM/bin/fan" src/build.fan xeto

echo "Assembling runtime home..."
rm -rf "$HOME_DIR"
mkdir -p "$HOME_DIR/bin" "$HOME_DIR/doc" "$HOME_DIR/etc" "$HOME_DIR/lib/fan" "$HOME_DIR/lib/java" "$HOME_DIR/lib/xeto"

rsync -a --exclude '.DS_Store' --exclude 'nstub.exe' "$FANTOM/bin/" "$HOME_DIR/bin/"
rsync -a --exclude '.DS_Store' "$FANTOM/etc/" "$HOME_DIR/etc/"
cp "$FANTOM/lib/java/sys.jar" "$HOME_DIR/lib/java/sys.jar"
if [[ -f "$FANTOM/lib/java/jline.jar" ]]; then
  cp "$FANTOM/lib/java/jline.jar" "$HOME_DIR/lib/java/jline.jar"
fi

copy_pods() {
  local from="$1" pod base
  [[ -d "$from" ]] || return 0
  for pod in "$from"/*.pod; do
    [[ -e "$pod" ]] || continue
    base="$(basename "$pod" .pod)"
    if skip_pod "$base"; then
      continue
    fi
    cp "$pod" "$HOME_DIR/lib/fan/"
  done
}

copy_pods "$FANTOM/lib/fan"
copy_pods "$HAYSTACK_DIR/lib/fan"
copy_pods "$SRC/lib/fan"

if [[ -d "$XETO_DIR/lib/xeto" ]]; then
  rsync -a --exclude '.DS_Store' --exclude 'hx.test*.xetolib' "$XETO_DIR/lib/xeto/" "$HOME_DIR/lib/xeto/"
fi
if [[ -d "$SRC/lib/xeto" ]]; then
  rsync -a --exclude '.DS_Store' --exclude 'hx.test*.xetolib' "$SRC/lib/xeto/" "$HOME_DIR/lib/xeto/"
fi

cp "$SRC/bin/hx" "$SRC/bin/hx.bat" "$SRC/bin/xeto" "$SRC/bin/xeto.bat" "$SRC/bin/axon" "$SRC/bin/axon.bat" "$HOME_DIR/bin/"
chmod +x "$HOME_DIR/bin/"*

if [[ -d "$SRC/etc/convert4" ]]; then
  mkdir -p "$HOME_DIR/etc/convert4"
  rsync -a --exclude '.DS_Store' "$SRC/etc/convert4/" "$HOME_DIR/etc/convert4/"
fi
if [[ -d "$SRC/etc/xeto" ]]; then
  mkdir -p "$HOME_DIR/etc/xeto"
  rsync -a --exclude '.DS_Store' "$SRC/etc/xeto/" "$HOME_DIR/etc/xeto/"
fi

if [[ -f "$HOME_DIR/etc/build/config.props" ]] && ! grep -q '^jdkHome=' "$HOME_DIR/etc/build/config.props"; then
  printf 'jdkHome=file:%s/\n' "${JDK_HOME%/}" >> "$HOME_DIR/etc/build/config.props"
fi

if [[ "$DOCS" -eq 1 ]]; then
  echo "Generating docs..."
  export FAN_HOME="$HOME_DIR"
  export PATH="$HOME_DIR/bin:$PATH"
  # Must run from the source tree so fan.props is on the env path.
  cd "$SRC"
  "$HOME_DIR/bin/fan" compilerDoc -all -outDir "$HOME_DIR/doc/"
  "$HOME_DIR/bin/xeto" doc-html -all -outDir "$HOME_DIR/doc/"
fi

echo
echo "Installed $HOME_DIR"
cd /tmp
unset FAN_HOME
"$HOME_DIR/bin/hx" version
