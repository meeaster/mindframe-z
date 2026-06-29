#!/usr/bin/env bash
# PROTOTYPE — throwaway. Answers: does Claude Code load hooks from
# ~/.claude/hooks.json, or only from ~/.claude/settings.json?
#
# Run: bash src/thread/proto-claude-hooks.sh
# Requires: docker, mindframe-z-thread-tools image built

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

IMAGE="${MFZ_THREAD_TOOLS_IMAGE:-mindframe-z-thread-tools:latest}"
WORKDIR="$(mktemp -d)"
trap "rm -rf '$WORKDIR'" EXIT

echo -e "${BOLD}Claude Hooks Path Validation${NC}"
echo -e "${DIM}Image: ${IMAGE}${NC}"
echo ""

# ---------------------------------------------------------------------------
# Build test hook configs — use SessionStart to write a marker file
# ---------------------------------------------------------------------------

# Test hook: SessionStart writes to /tmp/hook-fired
HOOK_ENTRY=$(cat <<'JSON'
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'HOOK FIRED' > /tmp/hook-fired"
          }
        ]
      }
    ]
  }
}
JSON
)

# Both files have the SAME content — the only difference is the path
echo "$HOOK_ENTRY" > "$WORKDIR/hooks.json"
echo "$HOOK_ENTRY" > "$WORKDIR/settings.json"

# ---------------------------------------------------------------------------
# Test A: hooks at ~/.claude/hooks.json (the current broken approach)
# ---------------------------------------------------------------------------

echo -e "${BOLD}Test A:${NC} hooks at ${DIM}~/.claude/hooks.json${NC}"
echo -e "${DIM}Running: claude -p 'say hello' in container...${NC}"

docker run --rm \
  -v "$WORKDIR/hooks.json:/home/sandbox/.claude/hooks.json:ro" \
  "$IMAGE" \
  bash -c 'claude -p "say hello" 2>/dev/null; test -f /tmp/hook-fired && echo "HOOK_FIRED" || echo "HOOK_NOT_FIRED"' \
  > "$WORKDIR/result-a.txt" 2>&1 || true

RESULT_A=$(cat "$WORKDIR/result-a.txt")
if echo "$RESULT_A" | grep -q "HOOK_FIRED"; then
  echo -e "  ${GREEN}PASS${NC} — hook fired (hooks.json IS read)"
else
  echo -e "  ${RED}FAIL${NC} — hook did NOT fire (hooks.json is NOT read)"
fi
echo ""

# ---------------------------------------------------------------------------
# Test B: hooks at ~/.claude/settings.json (the correct approach)
# ---------------------------------------------------------------------------

echo -e "${BOLD}Test B:${NC} hooks at ${DIM}~/.claude/settings.json${NC}"
echo -e "${DIM}Running: claude -p 'say hello' in container...${NC}"

docker run --rm \
  -v "$WORKDIR/settings.json:/home/sandbox/.claude/settings.json:ro" \
  "$IMAGE" \
  bash -c 'claude -p "say hello" 2>/dev/null; test -f /tmp/hook-fired && echo "HOOK_FIRED" || echo "HOOK_NOT_FIRED"' \
  > "$WORKDIR/result-b.txt" 2>&1 || true

RESULT_B=$(cat "$WORKDIR/result-b.txt")
if echo "$RESULT_B" | grep -q "HOOK_FIRED"; then
  echo -e "  ${GREEN}PASS${NC} — hook fired (settings.json IS read)"
else
  echo -e "  ${RED}FAIL${NC} — hook did NOT fire (settings.json is NOT read)"
fi
echo ""

# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------

echo -e "${BOLD}─${NC}$(printf '%.0s─' $(seq 1 40))"
echo ""

A_FIRED=$(echo "$RESULT_A" | grep -q "HOOK_FIRED" && echo "yes" || echo "no")
B_FIRED=$(echo "$RESULT_B" | grep -q "HOOK_FIRED" && echo "yes" || echo "no")

echo -e "hooks.json:     hook fired = ${A_FIRED}"
echo -e "settings.json:  hook fired = ${B_FIRED}"
echo ""

if [[ "$A_FIRED" == "no" && "$B_FIRED" == "yes" ]]; then
  echo -e "${GREEN}${BOLD}BUG CONFIRMED:${NC}${GREEN} hooks.json is ignored, settings.json works.${NC}"
  echo -e "${GREEN}Dockerfile.tools line 18 copies to the wrong path.${NC}"
elif [[ "$A_FIRED" == "yes" && "$B_FIRED" == "yes" ]]; then
  echo -e "${YELLOW}BOTH work — review finding may be incorrect for this Claude version.${NC}"
elif [[ "$A_FIRED" == "yes" && "$B_FIRED" == "no" ]]; then
  echo -e "${YELLOW}UNEXPECTED: hooks.json works but settings.json doesn't.${NC}"
else
  echo -e "${RED}NEITHER fired — check Claude CLI availability or hook format.${NC}"
fi

echo ""
echo -e "${DIM}Raw output at: $WORKDIR/result-a.txt, $WORKDIR/result-b.txt${NC}"
echo -e "${DIM}(preserved for inspection — temp dir not cleaned on error)${NC}"
