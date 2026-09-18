#!/usr/bin/env bash
# End-to-end SoundSuite indexing health probe via admin REST endpoints.
# Run after every build to verify Prisma / LadybugDB / LanceDB / FlexSearch.
set -u

ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-admin}"
PORT="${MCP_PORT:-3848}"
BASE="http://localhost:${PORT}/admin"
AUTH=(-u "${ADMIN_USER}:${ADMIN_PASS}")
PROJECT_NAME="SoundSuite"
FAILS=0
TOTAL=9

step() {
  local n="$1" name="$2" status="$3" detail="$4" body="${5:-}"
  echo "[${n}/${TOTAL}] ${name} — ${status} — ${detail}"
  if [[ "$status" == "FAIL" ]]; then
    FAILS=$((FAILS+1))
    [[ -n "$body" ]] && echo "    body: ${body}" | head -c 2000 && echo
  fi
}

# Require jq
command -v jq >/dev/null || { echo "jq required"; exit 2; }

# 1. searchProjects
RESP="$(curl -sS "${AUTH[@]}" "${BASE}/code-projects?limit=500" 2>&1)"
PID="$(echo "$RESP" | jq -r --arg n "$PROJECT_NAME" \
  'if type=="array" then . else (.projects // .data // .) end
   | (.[]? // empty) | select(.name==$n) | .id' | head -1)"
PPATH="$(echo "$RESP" | jq -r --arg n "$PROJECT_NAME" \
  'if type=="array" then . else (.projects // .data // .) end
   | (.[]? // empty) | select(.name==$n) | (.rootPath // .path // .root // "")' | head -1)"
FCOUNT="$(echo "$RESP" | jq -r --arg n "$PROJECT_NAME" \
  'if type=="array" then . else (.projects // .data // .) end
   | (.[]? // empty) | select(.name==$n) | (.functionCount // 0)' | head -1)"
if [[ -n "$PID" && "$PID" != "null" ]]; then
  step 1 "searchProjects" PASS "id=${PID} fns=${FCOUNT} path=${PPATH}"
else
  step 1 "searchProjects" FAIL "no project named ${PROJECT_NAME}" "$RESP"
  echo "FATAL: cannot continue without project id"; exit 1
fi

# 2. getIndexHealth
RESP="$(curl -sS "${AUTH[@]}" "${BASE}/code-projects/${PID}/health")"
WARN_COUNT="$(echo "$RESP" | jq -r '(.warnings // []) | length' 2>/dev/null || echo "?")"
PRISMA="$(echo "$RESP" | jq -r '.prisma.functions // "?"')"
LADY="$(echo "$RESP" | jq -r '.ladybug.nodes // "?"')"
LANCE="$(echo "$RESP" | jq -r '.lance.vectors // "?"')"
FLEX="$(echo "$RESP" | jq -r '.flexsearch.symbols // "?"')"
if echo "$RESP" | jq -e . >/dev/null 2>&1 && [[ -z "$(echo "$RESP" | jq -r '.error // empty')" ]]; then
  step 2 "getIndexHealth" PASS "prisma=${PRISMA} lady=${LADY} lance=${LANCE} flex=${FLEX} warns=${WARN_COUNT}"
else
  step 2 "getIndexHealth" FAIL "bad response" "$RESP"
fi

# 3. searchFantomCode keyword "classify"
RESP="$(curl -sS "${AUTH[@]}" -H "Content-Type: application/json" \
  -d "{\"query\":\"classify\",\"projectId\":${PID},\"limit\":10}" \
  "${BASE}/search/code")"
N="$(echo "$RESP" | jq -r '.count // -1')"
if [[ "$N" =~ ^[0-9]+$ && "$N" -gt 0 ]]; then
  step 3 "searchFantomCode(classify)" PASS "${N} hits"
else
  step 3 "searchFantomCode(classify)" FAIL "count=${N}" "$RESP"
fi

# 4. searchFantomCode keyword "ingest"
RESP="$(curl -sS "${AUTH[@]}" -H "Content-Type: application/json" \
  -d "{\"query\":\"ingest\",\"projectId\":${PID},\"limit\":10}" \
  "${BASE}/search/code")"
N="$(echo "$RESP" | jq -r '.count // -1')"
if [[ "$N" =~ ^[0-9]+$ && "$N" -gt 0 ]]; then
  step 4 "searchFantomCode(ingest)" PASS "${N} hits"
else
  step 4 "searchFantomCode(ingest)" FAIL "count=${N}" "$RESP"
fi

# 5. semanticCodeSearch "PDF document ingestion pipeline"
RESP="$(curl -sS "${AUTH[@]}" -H "Content-Type: application/json" \
  -d "{\"query\":\"PDF document ingestion pipeline\",\"projectId\":${PID},\"limit\":10}" \
  "${BASE}/search/semantic")"
N="$(echo "$RESP" | jq -r '.count // -1')"
if [[ "$N" =~ ^[0-9]+$ && "$N" -gt 0 ]]; then
  step 5 "semanticCodeSearch" PASS "${N} hits"
else
  step 5 "semanticCodeSearch" FAIL "count=${N}" "$RESP"
fi

# 6. listFunctionsInFile
TARGET=""
if [[ -n "$PPATH" && "$PPATH" != "null" ]]; then
  TARGET="${PPATH%/}/src/lib/ingestion/ingestion-pipeline.ts"
fi
if [[ -n "$TARGET" ]]; then
  RESP="$(curl -sS "${AUTH[@]}" --get \
    --data-urlencode "path=${TARGET}" \
    "${BASE}/code-projects/${PID}/file-symbols")"
  N="$(echo "$RESP" | jq -r '(.symbols // .functions // .items // []) | length' 2>/dev/null || echo 0)"
  if [[ "$N" =~ ^[0-9]+$ && "$N" -gt 0 ]]; then
    step 6 "listFunctionsInFile" PASS "${N} symbols in ${TARGET##*/}"
  else
    step 6 "listFunctionsInFile" FAIL "no symbols at ${TARGET}" "$RESP"
  fi
else
  step 6 "listFunctionsInFile" FAIL "no project rootPath" ""
fi

# 7. refreshFantomProject (incremental)
T0=$(date +%s)
RESP="$(curl -sS -m 600 "${AUTH[@]}" -X POST -H "Content-Type: application/json" \
  -d '{"force":true}' "${BASE}/code-projects/${PID}/reindex")"
T1=$(date +%s)
DUR=$((T1-T0))
ERR="$(echo "$RESP" | jq -r '.error // empty' 2>/dev/null || echo bad)"
ADDED="$(echo "$RESP" | jq -r '.addedCount // .added // 0' 2>/dev/null || echo 0)"
MOD="$(echo "$RESP" | jq -r '.modifiedCount // .modified // 0' 2>/dev/null || echo 0)"
if [[ -z "$ERR" && -n "$RESP" ]] && echo "$RESP" | jq -e . >/dev/null 2>&1; then
  step 7 "refreshFantomProject" PASS "${DUR}s added=${ADDED} modified=${MOD}"
else
  step 7 "refreshFantomProject" FAIL "${ERR:-empty/non-JSON response}" "$RESP"
fi

# 8. getIndexHealth post-refresh
RESP="$(curl -sS "${AUTH[@]}" "${BASE}/code-projects/${PID}/health")"
PRISMA2="$(echo "$RESP" | jq -r '.prisma.functions // "?"')"
LADY2="$(echo "$RESP" | jq -r '.ladybug.nodes // "?"')"
LANCE2="$(echo "$RESP" | jq -r '.lance.vectors // "?"')"
FLEX2="$(echo "$RESP" | jq -r '.flexsearch.symbols // "?"')"
if echo "$RESP" | jq -e . >/dev/null 2>&1 && [[ "$PRISMA2" != "?" && "$PRISMA2" != "null" ]]; then
  step 8 "getIndexHealth(post-refresh)" PASS "prisma=${PRISMA2} lady=${LADY2} lance=${LANCE2} flex=${FLEX2}"
else
  step 8 "getIndexHealth(post-refresh)" FAIL "stores look damaged or server dead" "$RESP"
fi

# 9. whatChangedRecently — use index-runs endpoint, filter to last 24h
SINCE=$(($(date +%s) - 86400))
RESP="$(curl -sS "${AUTH[@]}" "${BASE}/code-projects/${PID}/index-runs?limit=50")"
N="$(echo "$RESP" | jq -r --arg s "$SINCE" '
  [.runs[]? | select(
    (((.startedAt // "1970-01-01T00:00:00Z")
       | sub("\\.[0-9]+Z$";"Z")
       | fromdateiso8601) // 0) >= ($s|tonumber)
  )] | length
' 2>/dev/null || echo 0)"
if [[ "$N" =~ ^[0-9]+$ && "$N" -gt 0 ]]; then
  step 9 "whatChangedRecently(24h)" PASS "${N} index runs"
else
  step 9 "whatChangedRecently(24h)" FAIL "no recent runs (count=${N})" "$RESP"
fi

echo
if [[ $FAILS -eq 0 ]]; then
  echo "ALL ${TOTAL} CHECKS PASSED"; exit 0
else
  echo "${FAILS}/${TOTAL} CHECKS FAILED"; exit 1
fi
