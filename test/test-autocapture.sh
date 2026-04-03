#!/usr/bin/env bash
set -euo pipefail

# E2E test for the auto-capture engine
# Simulates Claude Code PostToolUseFailure hook input and verifies neuron creation

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
AUTOCAPTURE="$ROOT_DIR/mcp-server/dist/auto-capture.js"
NODE="${NODE_PATH:-node}"

# Create a temporary neurons directory for testing
TEST_DIR=$(mktemp -d)
mkdir -p "$TEST_DIR/neurons/errors" "$TEST_DIR/neurons/decisions" "$TEST_DIR/neurons/patterns" "$TEST_DIR/neurons/foundations"

PASS=0
FAIL=0

assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [[ "$expected" == "$actual" ]]; then
        echo "  ✓ $desc"
        PASS=$((PASS + 1))
    else
        echo "  ✗ $desc"
        echo "    expected: $expected"
        echo "    actual:   $actual"
        FAIL=$((FAIL + 1))
    fi
}

assert_contains() {
    local desc="$1" needle="$2" haystack="$3"
    if echo "$haystack" | grep -q "$needle"; then
        echo "  ✓ $desc"
        PASS=$((PASS + 1))
    else
        echo "  ✗ $desc — '$needle' not found"
        FAIL=$((FAIL + 1))
    fi
}

assert_file_exists() {
    local desc="$1" path="$2"
    if [[ -f "$path" ]]; then
        echo "  ✓ $desc"
        PASS=$((PASS + 1))
    else
        echo "  ✗ $desc — file not found: $path"
        FAIL=$((FAIL + 1))
    fi
}

echo "=== Auto-Capture E2E Tests ==="
echo ""

# ─── Test 1: TypeScript error from PostToolUseFailure ───────────
echo "Test 1: TypeScript error classification"

OUTPUT=$(echo '{
  "session_id": "test-1",
  "cwd": "'"$TEST_DIR"'",
  "hook_event_name": "PostToolUseFailure",
  "tool_name": "Bash",
  "tool_input": { "command": "npx tsc --noEmit" },
  "error": "Exit code 2\nsrc/index.ts(10,5): error TS2304: Cannot find name useState\nsrc/index.ts(15,1): error TS2345: Argument of type string is not assignable",
  "is_interrupt": false
}' | "$NODE" "$AUTOCAPTURE" 2>/dev/null || true)

assert_contains "Hook returned output" "auto-capture" "$OUTPUT"
assert_contains "Classified as TypeScript" "TypeScript" "$OUTPUT"
assert_file_exists "Neuron file created" "$TEST_DIR/neurons/errors/NE-001.md"

if [[ -f "$TEST_DIR/neurons/errors/NE-001.md" ]]; then
    CONTENT=$(cat "$TEST_DIR/neurons/errors/NE-001.md")
    assert_contains "Has fingerprint" "fingerprint:" "$CONTENT"
    assert_contains "Has auto_captured flag" "auto_captured: true" "$CONTENT"
    assert_contains "Domain is typescript" "domain: typescript" "$CONTENT"
    assert_contains "Type is error-memory" "type: error-memory" "$CONTENT"
fi

echo ""

# ─── Test 2: Dedup — same error again ──────────────────────────
echo "Test 2: Dedup (same error, occurrence bump)"

OUTPUT2=$(echo '{
  "session_id": "test-2",
  "cwd": "'"$TEST_DIR"'",
  "hook_event_name": "PostToolUseFailure",
  "tool_name": "Bash",
  "tool_input": { "command": "npx tsc --noEmit" },
  "error": "Exit code 2\nsrc/index.ts(10,5): error TS2304: Cannot find name useState",
  "is_interrupt": false
}' | "$NODE" "$AUTOCAPTURE" 2>/dev/null || true)

assert_contains "Recognized as known error" "Known error" "$OUTPUT2"
assert_contains "Shows occurrence count" "occurrence #2" "$OUTPUT2"

NEURON_COUNT=$(ls "$TEST_DIR/neurons/errors/" | wc -l | tr -d ' ')
assert_eq "Still only 1 neuron file" "1" "$NEURON_COUNT"

echo ""

# ─── Test 3: Missing module error ──────────────────────────────
echo "Test 3: Missing module error classification"

OUTPUT3=$(echo '{
  "session_id": "test-3",
  "cwd": "'"$TEST_DIR"'",
  "hook_event_name": "PostToolUseFailure",
  "tool_name": "Bash",
  "tool_input": { "command": "node server.js" },
  "error": "Exit code 1\nError: Cannot find module '"'"'express'"'"'\nRequire stack:\n- /app/server.js",
  "is_interrupt": false
}' | "$NODE" "$AUTOCAPTURE" 2>/dev/null || true)

assert_contains "Classified as missing module" "Missing module" "$OUTPUT3"
assert_file_exists "Second neuron created" "$TEST_DIR/neurons/errors/NE-002.md"

echo ""

# ─── Test 4: Ignored commands ──────────────────────────────────
echo "Test 4: Ignored commands (should NOT create neurons)"

BEFORE_COUNT=$(ls "$TEST_DIR/neurons/errors/" | wc -l | tr -d ' ')

# git status — should be ignored
echo '{
  "session_id": "test-4",
  "cwd": "'"$TEST_DIR"'",
  "hook_event_name": "PostToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "git status" },
  "tool_response": { "stdout": "On branch main", "stderr": "" }
}' | "$NODE" "$AUTOCAPTURE" 2>/dev/null || true

# ls — should be ignored
echo '{
  "session_id": "test-4b",
  "cwd": "'"$TEST_DIR"'",
  "hook_event_name": "PostToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "ls -la" },
  "tool_response": { "stdout": "total 0", "stderr": "" }
}' | "$NODE" "$AUTOCAPTURE" 2>/dev/null || true

AFTER_COUNT=$(ls "$TEST_DIR/neurons/errors/" | wc -l | tr -d ' ')
assert_eq "No new neurons for ignored commands" "$BEFORE_COUNT" "$AFTER_COUNT"

echo ""

# ─── Test 5: Compound command (cd && real_command) ─────────────
echo "Test 5: Compound command parsing"

OUTPUT5=$(echo '{
  "session_id": "test-5",
  "cwd": "'"$TEST_DIR"'",
  "hook_event_name": "PostToolUseFailure",
  "tool_name": "Bash",
  "tool_input": { "command": "cd /some/path && npm run build" },
  "error": "Exit code 1\nBuild failed with errors\nError: Module not found",
  "is_interrupt": false
}' | "$NODE" "$AUTOCAPTURE" 2>/dev/null || true)

assert_contains "Compound command not ignored" "auto-capture" "$OUTPUT5"

echo ""

# ─── Test 6: PostToolUse with stderr warnings (should ignore) ──
echo "Test 6: PostToolUse success with npm warnings (should ignore)"

BEFORE_COUNT=$(ls "$TEST_DIR/neurons/errors/" | wc -l | tr -d ' ')

echo '{
  "session_id": "test-6",
  "cwd": "'"$TEST_DIR"'",
  "hook_event_name": "PostToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "npm install" },
  "tool_response": { "stdout": "added 5 packages", "stderr": "npm warn deprecated package@1.0" }
}' | "$NODE" "$AUTOCAPTURE" 2>/dev/null || true

AFTER_COUNT=$(ls "$TEST_DIR/neurons/errors/" | wc -l | tr -d ' ')
assert_eq "npm warnings not captured" "$BEFORE_COUNT" "$AFTER_COUNT"

echo ""

# ─── Test 7: Git error ─────────────────────────────────────────
echo "Test 7: Git fatal error"

OUTPUT7=$(echo '{
  "session_id": "test-7",
  "cwd": "'"$TEST_DIR"'",
  "hook_event_name": "PostToolUseFailure",
  "tool_name": "Bash",
  "tool_input": { "command": "git push origin main" },
  "error": "Exit code 1\nfatal: remote origin already exists.",
  "is_interrupt": false
}' | "$NODE" "$AUTOCAPTURE" 2>/dev/null || true)

assert_contains "Classified as git error" "Git:" "$OUTPUT7"

echo ""

# ─── Cleanup ───────────────────────────────────────────────────
rm -rf "$TEST_DIR"

echo "=== Results ==="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo ""

if [[ $FAIL -gt 0 ]]; then
    echo "SOME TESTS FAILED"
    exit 1
else
    echo "ALL TESTS PASSED ✓"
    exit 0
fi
