#!/usr/bin/env bash
# Pre-flight lane — the light CI suite, run locally before `git push`.
#
# Agents (and humans) that open PRs run this and push only when it is green,
# so GitHub Actions confirms a change instead of being the first compiler it
# meets. It mirrors the `lint` job in .github/workflows/ci.yml plus the unit
# tests that touch the diff:
#
#   typecheck      tsc --noEmit
#   lint           oxlint (npm run lint)
#   format         prettier --check (npm run format:check)
#   depcruise      architecture boundaries
#   knip           dead code
#   ratchets       ratchet gates
#   function-size  function-size ratchet
#   tree           tree ratchet
#   only-skip      no .only()/.skip() left in tests
#   tests          vitest related <changed src files> (tests touched by the diff)
#   gitleaks       secrets in <base>..HEAD (skipped when the binary is absent)
#
# Every step runs even after one fails, so one pass reports everything that
# is red. Prints one verdict line and writes a JSON summary to
# .preflight/last.json. Exit 0 = green, 1 = red.
#
# Env:
#   PREFLIGHT_BASE   ref to diff against (default: origin/main)
#   PREFLIGHT_SKIP   comma-separated step names to skip (e.g. "knip,tests")
#   PREFLIGHT_QUIET  1 = keep step output in .preflight/*.log only

set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT" || exit 1

OUT_DIR="$ROOT/.preflight"
mkdir -p "$OUT_DIR"
RESULTS="$OUT_DIR/steps.tsv"
: >"$RESULTS"

BASE="${PREFLIGHT_BASE:-origin/main}"
if ! git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
  for candidate in main origin/HEAD HEAD~1; do
    if git rev-parse --verify --quiet "$candidate^{commit}" >/dev/null; then
      BASE="$candidate"
      break
    fi
  done
fi
SKIP=",${PREFLIGHT_SKIP:-},"
QUIET="${PREFLIGHT_QUIET:-0}"
BIN="$ROOT/node_modules/.bin"

now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

# step <name> <command...> — run one gate, record status + duration.
step() {
  local name="$1"
  shift
  local log="$OUT_DIR/$name.log"
  if [[ "$SKIP" == *",$name,"* ]]; then
    printf '%s\tskipped\t0\t%s\n' "$name" "PREFLIGHT_SKIP" >>"$RESULTS"
    echo "· $name — skipped (PREFLIGHT_SKIP)"
    return 0
  fi
  local start end status
  start=$(now_ms)
  if [[ "$QUIET" == "1" ]]; then
    "$@" >"$log" 2>&1
  else
    "$@" 2>&1 | tee "$log"
    (exit "${PIPESTATUS[0]}")
  fi
  status=$?
  end=$(now_ms)
  local ms=$((end - start))
  if [[ $status -eq 0 ]]; then
    printf '%s\tpass\t%s\t\n' "$name" "$ms" >>"$RESULTS"
    echo "✓ $name ($((ms / 1000))s)"
  else
    # First non-empty lines of the tail are what a reader needs to act on.
    local tail_note
    tail_note=$(tail -n 5 "$log" | tr '\t\n' '  ' | cut -c1-300)
    printf '%s\tfail\t%s\t%s\n' "$name" "$ms" "$tail_note" >>"$RESULTS"
    echo "✗ $name ($((ms / 1000))s) — see .preflight/$name.log"
  fi
  return 0
}

# skip_step <name> <reason> — record a step that could not run here.
skip_step() {
  printf '%s\tskipped\t0\t%s\n' "$1" "$2" >>"$RESULTS"
  echo "· $1 — skipped ($2)"
}

only_skip_check() {
  if grep -rn '\.only\s*(' --include='*.test.ts' src/__tests__/ ||
    grep -rn '\.skip\s*(' --include='*.test.ts' src/__tests__/; then
    echo "Found .only() or .skip() in test files — remove before pushing"
    return 1
  fi
  return 0
}

# Files this branch changes: committed since the merge-base with $BASE (so a
# moving main never drags other people's changes in), plus staged, unstaged
# and untracked work.
changed_files() {
  {
    git diff --name-only --diff-filter=d "$BASE...HEAD"
    git diff --name-only --diff-filter=d HEAD
    git ls-files --others --exclude-standard
  } | sort -u
}

# The unit tests related to the diff. `vitest related` walks the import graph
# from the changed sources, so a leaf edit runs a handful of files and a
# change to a hub module runs everything that imports it. A dependency or
# test-harness change reruns the whole suite; a change with nothing under
# src/ runs none. (Plain `vitest --changed` is not used: it treats any
# package.json edit — even a new npm script — as "rerun everything".)
changed_tests() {
  local all=() src=()
  mapfile -t all < <(changed_files)
  local f
  for f in "${all[@]}"; do
    case "$f" in
    package-lock.json | vitest.config.* | src/__tests__/setup/*)
      echo "tests: $f changed — running the full unit suite"
      "$BIN/vitest" run --reporter=dot
      return
      ;;
    src/*.ts | src/*.tsx | src/*.mts | src/*.js | src/*.mjs)
      src+=("$f")
      ;;
    esac
  done
  if [[ ${#src[@]} -eq 0 ]]; then
    echo "tests: no changed sources under src/ — nothing to run"
    return 0
  fi
  echo "tests: ${#src[@]} changed source file(s) — running related tests"
  "$BIN/vitest" related --run --passWithNoTests --reporter=dot "${src[@]}"
}

gitleaks_check() {
  gitleaks detect --no-banner --redact --source . \
    --log-opts="$BASE..HEAD"
}

if [[ ! -x "$BIN/tsc" ]]; then
  echo "preflight: node_modules missing — run \`npm ci\` first" >&2
  exit 1
fi

echo "preflight: base=$BASE head=$(git rev-parse --short HEAD)"
T0=$(now_ms)

step typecheck "$BIN/tsc" --noEmit
step lint npm run --silent lint
step format npm run --silent format:check
step depcruise npm run --silent depcruise
step knip npm run --silent knip
step ratchets npm run --silent ratchets
step function-size npm run --silent function-size
step tree npm run --silent tree
step only-skip only_skip_check
step tests changed_tests
if command -v gitleaks >/dev/null 2>&1; then
  step gitleaks gitleaks_check
else
  skip_step gitleaks "gitleaks binary not installed"
fi

T1=$(now_ms)

node - "$RESULTS" "$OUT_DIR/last.json" "$BASE" "$((T1 - T0))" <<'NODE'
const fs = require("node:fs");
const { execSync } = require("node:child_process");
const [, , tsv, out, base, totalMs] = process.argv;
const steps = fs
  .readFileSync(tsv, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [name, status, ms, note] = line.split("\t");
    return {
      name,
      status,
      ms: Number(ms),
      ...(note ? { note } : {}),
    };
  });
const failed = steps.filter((s) => s.status === "fail").map((s) => s.name);
const skipped = steps.filter((s) => s.status === "skipped").map((s) => s.name);
let head = "";
let branch = "";
try {
  head = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  branch = execSync("git rev-parse --abbrev-ref HEAD", {
    encoding: "utf8",
  }).trim();
} catch {}
const summary = {
  verdict: failed.length === 0 ? "green" : "red",
  ok: failed.length === 0,
  base,
  head,
  branch,
  finishedAt: new Date().toISOString(),
  totalMs: Number(totalMs),
  failed,
  skipped,
  steps,
};
fs.writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");
NODE

VERDICT=$(node -e 'const s=require(process.argv[1]);process.stdout.write(s.ok?"GREEN":"RED — failed: "+s.failed.join(", "))' "$OUT_DIR/last.json")
echo "preflight: $VERDICT in $(((T1 - T0) / 1000))s — summary at .preflight/last.json"
[[ "$VERDICT" == GREEN ]]
