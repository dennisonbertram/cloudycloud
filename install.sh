#!/usr/bin/env bash
# Sets up claude-cloud: checks tools, links the command, and asks for each key.
# Run it from a clone, in a terminal: ./install.sh
# Secrets are handled with shell builtins only (read, printf) and never appear in argv.

API=https://api.instabox.sh
DASH=https://dashboard.instabox.sh/dashboard/api-keys

cfg() { printf '%s' "${CLAUDE_CLOUD_CONFIG:-$HOME/.config/claude-cloud/env}"; }

valid_ibk() { [[ $1 =~ ^ibk_[a-z2-7]{52}$ ]]; }
valid_claude() { [[ $1 == sk-ant-oat01-* ]]; }
claude_len_ok() { [ "${#1}" -eq 108 ]; }
mask() { printf '%s…%s' "$1" "${2: -4}"; } # mask PREFIX VALUE

# Writes NAME=value into the config: private temp file in the same folder, then rename.
write_env() {
  local name=$1 value=$2 file dir
  file=$(cfg); dir=${file%/*}
  (
    umask 077
    [ -d "$dir" ] || { mkdir -p "$dir" && chmod 700 "$dir"; } || exit 1
    t="$file.tmp.$$"
    { [ -f "$file" ] && grep -v "^$name=" "$file"; true; } > "$t"
    printf '%s=%s\n' "$name" "$value" >> "$t"
    mv "$t" "$file" || { rm -f "$t"; exit 1; }
  )
}

get_saved() { # prints the saved value of NAME, or nothing
  local line
  line=$(grep "^$1=" "$(cfg)" 2>/dev/null | tail -n 1) || true
  printf '%s' "${line#*=}"
}

# Prints the HTTP status of GET /v1/machines for a key. The key goes to curl on stdin.
http_code() {
  local code
  code=$(printf 'header = "X-API-Key: %s"\n' "$1" |
    curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -K - "$API/v1/machines" 2>/dev/null) || true
  printf '%s' "${code:-000}"
}

api_get() { printf 'header = "X-API-Key: %s"\n' "$1" | curl -sS --max-time 15 -K - "$API$2" 2>/dev/null; }

yn() { # yn QUESTION: default no
  local a
  printf '%s [y/N] ' "$1" >&2
  IFS= read -r a </dev/tty || a=""
  [[ $a == [yY]* ]]
}

read_secret() { # read_secret VAR: hidden input, trimmed, stored in the named variable
  local v
  IFS= read -rs v </dev/tty || v=""
  echo >&2
  v=${v//$'\r'/}; v=${v#"${v%%[![:space:]]*}"}; v=${v%"${v##*[![:space:]]}"}
  printf -v "$1" '%s' "$v"
}

stop_empty() { echo "Stopped. Run ./install.sh again to continue." >&2; exit 1; }

check_prereqs() {
  local bad=0 v major
  command -v git >/dev/null || { echo "git is missing. Install it: https://git-scm.com/downloads"; bad=1; }
  v=none
  command -v node >/dev/null && v=$(node -v 2>/dev/null)
  major=${v#v}; major=${major%%.*}
  if ! [[ $major =~ ^[0-9]+$ ]] || [ "$major" -lt 20 ]; then
    echo "Node.js 20 or later is needed (found $v). Install it: https://nodejs.org"; bad=1
  fi
  command -v npm >/dev/null || { echo "npm is missing."; bad=1; }
  command -v curl >/dev/null || { echo "curl is missing."; bad=1; }
  command -v claude >/dev/null || { echo "Claude Code is missing. Install it: https://code.claude.com"; bad=1; }
  return $bad
}

warn_shell_env() {
  [ -z "${!1:-}" ] || echo "Note: $1 is also set in your shell. claude-cloud uses the shell value, not the saved one."
}

link_command() { # link_command ROOT
  local root=$1 cur other
  cur=$(command -v claude-cloud) || cur=""
  if [ -z "$cur" ]; then
    (cd "$root" && npm link >/dev/null) || { echo "npm link failed." >&2; exit 1; }
    command -v claude-cloud >/dev/null ||
      echo "Add this to your shell profile: export PATH=\"$(npm prefix -g)/bin:\$PATH\""
    return
  fi
  other=$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$cur")
  if [ "$other" = "$root/bin/claude-cloud" ]; then
    echo "claude-cloud already runs from this folder."
  else
    other=${other%/bin/claude-cloud}
    if yn "claude-cloud on your PATH runs from $other. Point it at this folder instead?"; then
      (cd "$root" && npm link >/dev/null) || { echo "npm link failed." >&2; exit 1; }
    fi
  fi
}

setup_instabox() {
  local saved code key
  saved=$(get_saved INSTABOX_API_KEY)
  if [ -n "$saved" ]; then
    code=$(http_code "$saved")
    if [ "$code" = 200 ]; then
      yn "Instabox API key: saved ($(mask ibk_ "$saved")) and working. Replace it?" || return 0
    else
      echo "Instabox API key: saved ($(mask ibk_ "$saved")) but the check failed (HTTP $code)."
    fi
  fi
  while :; do
    printf '%s\n%s ' "Instabox API key: create one at $DASH (starts with ibk_)." "Paste it (nothing shows as you paste):"
    read_secret key
    [ -n "$key" ] || stop_empty
    if ! valid_ibk "$key"; then
      echo "That doesn't look like an Instabox API key (ibk_ followed by 52 letters a-z and digits 2-7). Try again."; continue
    fi
    code=$(http_code "$key")
    case $code in
      200) echo "Instabox key works." ;;
      401|403) echo "Instabox rejected this key. Create a new one at $DASH."; continue ;;
      *) yn "Could not check the key (HTTP $code). Save it anyway?" || continue ;;
    esac
    write_env INSTABOX_API_KEY "$key" || { echo "Could not write $(cfg)." >&2; exit 1; }
    echo "Saved the Instabox key ($(mask ibk_ "$key"))."
    return
  done
}

setup_claude() {
  local saved key
  saved=$(get_saved CLAUDE_CODE_OAUTH_TOKEN)
  if [ -n "$saved" ]; then
    yn "Claude token: saved ($(mask sk-ant-oat01- "$saved")). Replace it?" || return 0
  elif [ -n "$(get_saved ANTHROPIC_API_KEY)" ]; then
    yn "Claude login for subagents: an ANTHROPIC_API_KEY is saved (billed per use). Replace it with a setup-token?" || return 0
  fi
  while :; do
    printf '%s\n%s ' "Claude token for subagents: in another terminal run \`claude setup-token\`, then paste the token here (starts with sk-ant-oat01-). Your own claude login is not changed." "Paste it (nothing shows as you paste):"
    read_secret key
    [ -n "$key" ] || stop_empty
    valid_claude "$key" || { echo "That doesn't look like a token from claude setup-token. Try again."; continue; }
    if ! claude_len_ok "$key"; then
      yn "This token is ${#key} characters; tokens from claude setup-token are usually 108. Save it anyway?" || continue
    fi
    write_env CLAUDE_CODE_OAUTH_TOKEN "$key" || { echo "Could not write $(cfg)." >&2; exit 1; }
    echo "Saved the Claude token ($(mask sk-ant-oat01- "$key"))."
    return
  done
}

# Prints yes, no, or unknown (the org lookup failed or has an unexpected shape).
gh_secret_state() {
  local key orgs id secrets
  key=$(get_saved INSTABOX_API_KEY)
  orgs=$(api_get "$key" /v1/orgs) || true
  id=$(printf '%s' "$orgs" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);
    const a=Array.isArray(j)?j:(j.items||j.data||j.orgs||[]);const o=a.find(x=>x&&x.personal)||a[0];console.log(o&&o.id||"")}catch{console.log("")}})') || true
  [[ $id =~ ^[A-Za-z0-9_.-]+$ ]] || { echo unknown; return; }
  secrets=$(api_get "$key" "/v1/orgs/$id/secrets") || true
  printf '%s' "$secrets" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);
    const a=Array.isArray(j)?j:(j.items||j.data||j.secrets||[]);
    console.log(a.some(x=>x.name==="GH_TOKEN"&&["github.com","api.github.com"].every(h=>(x.hosts||[]).includes(h)))?"yes":"no")}catch{console.log("unknown")}})'
}

setup_github() {
  local state
  state=$(gh_secret_state)
  if [ "$state" = unknown ]; then
    echo "Could not confirm GH_TOKEN (could not read your Instabox orgs). Check with: npx --yes instabox@latest secrets ls"
    return
  fi
  if [ "$state" = yes ]; then
    yn "GitHub token: stored in Instabox as GH_TOKEN. Replace it?" || return 0
  fi
  cat <<'MSG'
GitHub token: subagents push their branches with it. Instabox stores it; subagent machines only see a placeholder.
Create a fine-grained token at https://github.com/settings/personal-access-tokens/new
  Repository access: only the repos you'll use with claude-cloud
  Permissions: Contents, read and write
Next, the Instabox CLI signs you in (if needed) and asks for the token. Nothing shows as you paste.
MSG
  # The token goes from the terminal straight to the Instabox CLI; this script never sees it.
  npx --yes instabox@latest whoami >/dev/null 2>&1 || npx --yes instabox@latest login </dev/tty
  npx --yes instabox@latest secrets set GH_TOKEN --host github.com --host api.github.com </dev/tty
  state=$(gh_secret_state)
  if [ "$state" = no ]; then
    echo "GH_TOKEN is not visible to your Instabox API key. The Instabox CLI may be signed in to a different account or workspace: check with npx instabox@latest whoami, then run ./install.sh again." >&2
    exit 1
  fi
  [ "$state" = yes ] || echo "Could not confirm GH_TOKEN (could not read your Instabox orgs). Check with: npx --yes instabox@latest secrets ls"
}

# Optional: a provider key for open-model workers (profiles glm, deepseek, particle, openrouter).
setup_provider() { # setup_provider NAME LABEL WHERE
  local name=$1 label=$2 where=$3 saved key
  saved=$(get_saved "$name")
  if [ -n "$saved" ]; then
    yn "$label key: saved ($(mask "" "$saved")). Replace it?" || return 0
  fi
  printf '%s\n%s ' "$label key for open-model workers (optional, Enter to skip): get one at $where." "Paste it (nothing shows as you paste):"
  read_secret key
  [ -n "$key" ] || { echo "Skipped $label."; return 0; }
  write_env "$name" "$key" || { echo "Could not write $(cfg)." >&2; exit 1; }
  echo "Saved the $label key ($(mask "" "$key")). Note: unlike GH_TOKEN, this key is stored on the worker machines that use it."
}

main() {
  if [ "${1:-}" != --check-only ] && [ ! -t 0 ]; then
    echo "install.sh asks for keys, so run it in a terminal: ./install.sh"; exit 1
  fi
  check_prereqs || exit 1
  [ "${1:-}" = --check-only ] && exit 0

  trap 'stty echo 2>/dev/null' EXIT
  trap 'exit 130' INT TERM

  local root branch sha
  root=$(cd "$(dirname "$0")" && pwd)
  (cd "$root" && npm install) || { echo "npm install failed." >&2; exit 1; }
  link_command "$root"

  warn_shell_env INSTABOX_API_KEY
  warn_shell_env CLAUDE_CODE_OAUTH_TOKEN
  setup_instabox
  setup_claude
  setup_github
  setup_provider PARTICLE_API_KEY Particle.ai https://platform.particle.ai
  setup_provider OPENROUTER_API_KEY OpenRouter https://openrouter.ai/keys

  branch=$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null)
  sha=$(git -C "$root" rev-parse --short HEAD 2>/dev/null)
  cat <<MSG

Ready. claude-cloud runs from $root (branch $branch at $sha).
To update later: git -C $root pull && npm --prefix $root install
Restart any open claude-cloud session to use the new keys.

Recommended: block direct pushes to your main branch on GitHub (Settings > Rules > Rulesets). Subagents can push to any branch the token reaches.

Try it:
  cd <a repo with a github.com origin>
  claude-cloud
  then type: use a subagent to run hostname, write it to proof.txt, commit and push, and tell me the result
MSG
}

[ "${BASH_SOURCE[0]}" = "$0" ] && main "$@"
