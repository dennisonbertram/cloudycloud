#!/usr/bin/env bash
# End-to-end test: runs one real subagent on Instabox in a throwaway repo. Prints PASS or FAIL.
# Keys come from INSTABOX_API_KEY and CLAUDE_CODE_OAUTH_TOKEN, or are asked for (hidden) and not saved.
set -eu
root=$(cd "$(dirname "$0")" && pwd)

ask() { # ask VAR "prompt"
  [ -n "${!1:-}" ] && return
  [ -t 0 ] || { echo "FAIL: $1 is not set" >&2; exit 1; }
  read -rsp "$2: " "$1"; echo
  [ -n "${!1}" ] || { echo "FAIL: $1 is empty" >&2; exit 1; }
}
ask INSTABOX_API_KEY "Instabox API key (ibk_...)"
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "Get a Claude token by running this in another terminal: claude setup-token"
  ask CLAUDE_CODE_OAUTH_TOKEN "Claude token"
fi
export INSTABOX_API_KEY CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"

[ -d "$root/node_modules" ] || (cd "$root" && npm install --silent)

# The key goes through stdin so it never appears in process arguments.
machines=$(printf 'header = "X-API-Key: %s"\n' "$INSTABOX_API_KEY" |
  curl -sS --max-time 20 -K - https://api.instabox.sh/v1/machines)
count=$(printf '%s' "$machines" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).machines.length)}catch{console.log("error")}})')
if [ "$count" = error ]; then
  echo "FAIL: Instabox rejected the request: $machines" >&2
  exit 1
fi
if [ "$count" != 0 ]; then
  echo "Note: this account already has $count machine(s). The free plan allows 1, so this test may fail with quota_exceeded."
fi

repo=$(mktemp -d)
trap 'rm -rf "$repo"' EXIT
cd "$repo"
git init -q -b main
echo 'claude-cloud test repo' > README.md
git add README.md
git -c user.name=test -c user.email=test@example.invalid commit -qm init

echo "Running one subagent on Instabox. This usually takes a minute or two..."
"$root/bin/claude-cloud" -p --model haiku --allowedTools mcp__cloud__cloud_agent --output-format text \
  "Call mcp__cloud__cloud_agent exactly once with description 'end to end test', model 'haiku', and this prompt: 'Run the hostname command, write its exact output to a new file named proof.txt, and stop.' Then print the tool's exact result." \
  < /dev/null || true

branch=$(git branch --list 'claude-cloud/*' --format='%(refname:short)' | head -1)
proof=$([ -n "$branch" ] && git show "$branch:proof.txt" 2>/dev/null || true)
echo
case $proof in
  instabox-sbx-*) echo "PASS: the subagent ran on $proof and its file came back on a local branch." ;;
  *) echo "FAIL: no proof file from an Instabox machine came back (branch: ${branch:-none}, contents: ${proof:-none}). See the output above."; exit 1 ;;
esac
