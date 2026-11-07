#!/usr/bin/env bash
# Sets up claude-cloud: checks tools, links the command, and asks for each key.
# Run it from a clone, in a terminal: ./install.sh
# Secrets are handled with shell builtins only (read, printf) and never appear in argv.

API=https://api.instabox.sh
DASH=https://dashboard.instabox.sh/dashboard/api-keys

cfg() { printf '%s' "${CLAUDE_CLOUD_CONFIG:-$HOME/.config/claude-cloud/env}"; }

valid_ibk() { [[ $1 =~ ^ibk_[a-z2-7]{52}$ ]]; }
valid_claude() { [[ $1 == sk-ant-oat01-* ]]; }
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

# Discards anything waiting on the terminal, so a leftover fragment cannot answer a question.
drain_tty() {
  { : </dev/tty; } 2>/dev/null || return 0
  if command -v perl >/dev/null; then
    perl -e 'use Fcntl; open(T,"</dev/tty") or exit; fcntl(T,F_SETFL,O_NONBLOCK); 1 while sysread(T,$b,4096)' 2>/dev/null || true
  else
    while IFS= read -rs -t 1 -n 1000 _ </dev/tty; do :; done # read -t takes whole seconds on macOS bash 3.2
  fi
}

yn() { # yn QUESTION: default no
  local a
  drain_tty
  printf '%s [y/N] ' "$1" >&2
  IFS= read -r a </dev/tty || a=""
  [[ $a == [yY]* ]]
}

# clean_paste TEXT: prints TEXT without whitespace, control characters and terminal escape sequences
# (including the bracketed-paste markers ESC[200~ and ESC[201~).
clean_paste() {
  local v=$1 re
  re=$'\e'"\\[[0-9;?]*[A-Za-z~]"
  while [[ $v =~ $re ]]; do v=${v/"${BASH_REMATCH[0]}"/}; done
  v=${v//\[200~/}; v=${v//\[201~/} # markers whose ESC byte was already dropped
  v=${v//[[:space:]]/}; v=${v//[[:cntrl:]]/}
  printf '%s' "$v"
}

# read_secret VAR: hidden input (callers run drain_tty before the prompt); reads the first line, then any further lines of the same paste.
read_secret() {
  local v more
  IFS= read -rs v </dev/tty || v=""
  echo >&2
  if [ -n "$v" ]; then # a long token can wrap onto a second line
    while :; do
      more=""
      IFS= read -rs -t 1 more </dev/tty || { v+=$more; break; } # on timeout, keep any partial line
      v+=$more
    done
  fi
  printf -v "$1" '%s' "$v"
}

stop_empty() { echo "Stopped. Run $(rerun_cmd) again to continue." >&2; exit 1; }

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

KEYLEN=56   # length of an Instabox key: ibk_ plus 52 characters
TOKLEN=108  # usual length of a token from claude setup-token
STATUS_INSTABOX="not set up"; STATUS_CLAUDE="not set up"; STATUS_GH="not checked"; STATUS_COORD="not set up"
LOCAL_ACCOUNT=""

# rerun_cmd: the command that runs setup again.
rerun_cmd() { if command -v claude-cloud >/dev/null 2>&1; then printf 'claude-cloud setup'; else printf './install.sh'; fi; }

# strip_escapes TEXT: prints TEXT without terminal escape sequences and carriage returns.
strip_escapes() {
  local v=$1 re
  re=$'\e'"\\[[0-9;?]*[A-Za-z~]"
  while [[ $v =~ $re ]]; do v=${v/"${BASH_REMATCH[0]}"/}; done
  v=${v//$'\r'/}
  printf '%s' "$v"
}

del_env() { # del_env NAME: removes NAME from the config file, if present
  local file t
  file=$(cfg); [ -f "$file" ] || return 0
  t="$file.tmp.$$"
  ( umask 077; grep -v "^$1=" "$file" > "$t"; mv "$t" "$file" ) || rm -f "$t"
}

# preview VALUE: first 8 and last 4 characters only, and only for values long enough to hide the middle.
preview() { [ "${#1}" -gt 16 ] && printf '%s…%s' "${1:0:8}" "${1: -4}"; true; }

# parse_ibk RAW: sets PARSED to the key found in what was pasted, or prints why not and returns 1.
parse_ibk() {
  local raw c n
  PARSED=""
  raw=$(clean_paste "$1")
  if [[ $raw =~ ibk_[A-Za-z0-9_-]* ]]; then
    c=${BASH_REMATCH[0]}; n=${#c}
    if valid_ibk "$c"; then PARSED=$c; return 0; fi
    if [[ $c =~ ^ibk_[a-z2-7]*$ ]] && [ "$n" -lt "$KEYLEN" ]; then
      echo "Got $n of $KEYLEN characters, so it looks cut off. Copy the whole key again; it may wrap onto two lines, which is fine to paste."
    else
      echo "That starts like an Instabox key${c:+ ($(preview "$c"))} but is not one: it should be ibk_ followed by 52 letters a-z and digits 2-7."
    fi
  else
    echo "That doesn't look like an Instabox API key. It should start with ibk_. Create one at $DASH."
  fi
  echo "The dashboard shows a key only once, when you create it. If you lost it, create a new one at $DASH."
  return 1
}

# parse_claude RAW: sets PARSED to the token found in what was pasted, or prints why not and returns 1.
parse_claude() {
  local raw n
  PARSED=""
  raw=$(clean_paste "$1")
  if [[ $raw =~ sk-ant-oat01-[A-Za-z0-9_-]* ]]; then
    PARSED=${BASH_REMATCH[0]}; n=${#PARSED}
    if [ "$n" -lt "$TOKLEN" ]; then
      echo "Got $n of $TOKLEN characters, so it looks cut off. Copy the whole token again; it may wrap onto two lines, which is fine to paste."
      PARSED=""; return 1
    fi
    return 0
  fi
  echo "That doesn't look like a token from claude setup-token. It should start with sk-ant-oat01-. In another terminal run: claude setup-token"
  return 1
}

# claude_account [TOKEN]: prints the email of the Claude account (the local login, or the one the token belongs to).
claude_account() {
  local json
  if [ -n "${1:-}" ]; then json=$(CLAUDE_CODE_OAUTH_TOKEN="$1" claude auth status </dev/null 2>/dev/null) || true
  else json=$(claude auth status </dev/null 2>/dev/null) || true; fi
  printf '%s' "$json" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);
    const e=j.email||(j.account&&j.account.email)||j.emailAddress||"";console.log(/^[^\s@]+@[^\s@]+$/.test(e)?e:"")}catch{console.log("")}})' 2>/dev/null || true
}

# claude_check TOKEN: one tiny request. Prints "ok", "fail REASON" or "unrun REASON". The token goes in the environment only.
claude_check() {
  local f rc pid wd out reason secs=${CLAUDE_CLOUD_CHECK_SECONDS:-60}
  f=$(mktemp) || { echo "unrun could not create a temporary file"; return; }
  CLAUDE_CODE_OAUTH_TOKEN="$1" claude -p --model haiku "Reply with ok" </dev/null >"$f" 2>&1 &
  pid=$!
  ( sleep "$secs" & sp=$!; trap 'kill $sp 2>/dev/null; exit 0' TERM; wait $sp; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  wd=$!
  wait "$pid" 2>/dev/null; rc=$?
  kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  out=$(<"$f"); rm -f "$f"
  out=${out//"$1"/}
  reason=$(printf '%s' "$out" | tr -d '\r' | grep -v '^[[:space:]]*$' | tail -n 1 | cut -c1-120)
  if [ "$rc" -eq 0 ]; then echo ok
  elif [ "$rc" -eq 143 ] || [ "$rc" -eq 137 ]; then echo "unrun it took longer than $secs seconds"
  elif printf '%s' "$out" | grep -qiE 'enotfound|econn|network|fetch failed|timed out|offline|could not resolve|unable to connect'; then echo "unrun ${reason:-no network}"
  elif printf '%s' "$out" | grep -qiE '401|authenticat|invalid|expired|unauthori|log ?in|oauth|revoked'; then echo "fail ${reason:-the token was rejected}"
  else echo "fail ${reason:-claude exited with code $rc}"; fi
}

CAPTURE_FILE=""; CAPTURE_TTY=""
cleanup_capture() {
  [ -z "$CAPTURE_FILE" ] || rm -f "$CAPTURE_FILE"
  CAPTURE_FILE=""
  if [ -n "$CAPTURE_TTY" ]; then stty $CAPTURE_TTY </dev/tty 2>/dev/null || true; CAPTURE_TTY=""; fi
}

# run_setup_token FILE: runs claude setup-token in a pty and records the output in FILE.
run_setup_token() {
  if [ "$(uname)" = Darwin ]; then script -q "$1" claude setup-token </dev/tty
  else script -qc "claude setup-token" "$1" </dev/tty; fi
}

# capture_token: gets a token from claude setup-token without copying. Prints the token, or a reason on stderr and returns 1.
capture_token() {
  local out tok size
  CAPTURE_FILE=$(umask 077; mktemp) || { echo "Could not create a temporary file." >&2; return 1; }
  size=$(stty size </dev/tty 2>/dev/null) || size=""
  if [ -n "$size" ]; then CAPTURE_TTY="rows ${size% *} cols ${size#* }"; stty cols 500 </dev/tty 2>/dev/null || true; fi
  run_setup_token "$CAPTURE_FILE" >&2 || true
  out=$(strip_escapes "$(cat "$CAPTURE_FILE" 2>/dev/null)")
  cleanup_capture
  if [[ $out =~ sk-ant-oat01-[A-Za-z0-9_-]* ]]; then
    tok=${BASH_REMATCH[0]}
    if [ "${#tok}" -ge "$TOKLEN" ]; then printf '%s' "$tok"; return 0; fi
    echo "The sign-in gave only ${#tok} of $TOKLEN characters of the token, so it looks cut off." >&2
  else
    echo "Could not find a token in what the sign-in printed." >&2
  fi
  return 1
}

setup_instabox() {
  local saved code key tries=0
  saved=$(get_saved INSTABOX_API_KEY)
  if [ -n "$saved" ]; then
    code=$(http_code "$saved")
    if [ "$code" = 200 ]; then
      STATUS_INSTABOX="OK ($(mask ibk_ "$saved"))"
      yn "Instabox API key: saved ($(mask ibk_ "$saved")) and working. Replace it?" || return 0
    else
      echo "Instabox API key: saved ($(mask ibk_ "$saved")) but the check failed (HTTP $code)."
    fi
  fi
  while [ "$tries" -lt 3 ]; do
    drain_tty
    printf '%s\n%s ' "Instabox API key: create one at $DASH (starts with ibk_)." "Paste it (nothing shows as you paste${saved:+; Enter keeps the saved key}):"
    read_secret key
    if [ -z "$key" ]; then
      [ -n "$saved" ] || stop_empty
      echo "Kept the saved key."; return 0
    fi
    if ! parse_ibk "$key"; then tries=$((tries + 1)); continue; fi
    key=$PARSED
    code=$(http_code "$key")
    case $code in
      200) echo "Instabox key works." ;;
      401|403) echo "Instabox rejected this key. Create a new one at $DASH."; tries=$((tries + 1)); continue ;;
      *) yn "Could not check the key (HTTP $code). Save it anyway?" || { tries=$((tries + 1)); continue; } ;;
    esac
    write_env INSTABOX_API_KEY "$key" || { echo "Could not write $(cfg)." >&2; exit 1; }
    STATUS_INSTABOX="OK ($(mask ibk_ "$key"))"
    echo "Saved the Instabox key ($(mask ibk_ "$key"))."
    return
  done
  if [ -n "$saved" ]; then echo "Stopped the Instabox step after 3 tries. Your saved key is unchanged. Run $(rerun_cmd) again to retry."
  else echo "Stopped the Instabox step after 3 tries. Nothing is saved. Run $(rerun_cmd) again to retry."; fi
}

setup_claude() {
  local saved key tries=0 auto=1 acct marker result reason
  saved=$(get_saved CLAUDE_CODE_OAUTH_TOKEN)
  marker=$(get_saved CLAUDE_CLOUD_TOKEN_ACCOUNT)
  if [ -n "$saved" ]; then
    STATUS_CLAUDE="OK ($(mask sk-ant-oat01- "$saved")${marker:+, $marker})"
    if [ -n "$marker" ] && [ -n "$LOCAL_ACCOUNT" ] && [ "$marker" != "$LOCAL_ACCOUNT" ]; then
      yn "Claude token: the saved token is for $marker, but your local Claude is $LOCAL_ACCOUNT. Replace it?" || return 0
    else
      yn "Claude token: saved ($(mask sk-ant-oat01- "$saved")${marker:+, account $marker}). Replace it?" || return 0
    fi
  elif [ -n "$(get_saved ANTHROPIC_API_KEY)" ]; then
    yn "Claude login for subagents: an ANTHROPIC_API_KEY is saved (billed per use). Replace it with a setup-token?" || return 0
  fi
  while [ "$tries" -lt 3 ]; do
    drain_tty
    if [ "$auto" = 1 ]; then
      printf '%s\n%s ' "Claude token for subagents. Press Enter to get a token now (a browser opens; sign in with the account subagents should use), or paste one. Your own claude login is not changed." "Enter, or paste a token (nothing shows as you paste):"
    else
      printf '%s ' "Paste the token (starts with sk-ant-oat01-; nothing shows as you paste${saved:+; Enter keeps the saved token}):"
    fi
    read_secret key
    if [ -z "$key" ]; then
      if [ "$auto" = 1 ]; then
        auto=0
        echo "Starting claude setup-token. Follow the browser sign-in; you do not need to copy anything."
        if key=$(capture_token); then :; else
          echo "Paste a token instead: in another terminal run claude setup-token, then copy it here."; continue
        fi
      else
        [ -n "$saved" ] || stop_empty
        echo "Kept the saved key."; return 0
      fi
    else
      auto=0
    fi
    if ! parse_claude "$key"; then tries=$((tries + 1)); continue; fi
    key=$PARSED
    [ "${#key}" -eq "$TOKLEN" ] || echo "Note: this token is ${#key} characters; tokens from claude setup-token are usually $TOKLEN. The format may have changed, so the check below decides."
    echo "Checking the token with a tiny Claude request (this uses a very small amount of Claude usage)..."
    result=$(claude_check "$key"); reason=${result#* }
    case $result in
      ok) echo "Claude token works." ;;
      fail*) echo "Claude rejected this token: $reason"; echo "Make a fresh one with claude setup-token and try again."; tries=$((tries + 1)); continue ;;
      *) yn "Could not check the token ($reason). Save it anyway?" || { tries=$((tries + 1)); continue; } ;;
    esac
    write_env CLAUDE_CODE_OAUTH_TOKEN "$key" || { echo "Could not write $(cfg)." >&2; exit 1; }
    acct=$(claude_account "$key")
    if [ -n "$acct" ]; then write_env CLAUDE_CLOUD_TOKEN_ACCOUNT "$acct"; else del_env CLAUDE_CLOUD_TOKEN_ACCOUNT; fi
    STATUS_CLAUDE="OK ($(mask sk-ant-oat01- "$key")${acct:+, $acct})"
    echo "Saved the Claude token ($(mask sk-ant-oat01- "$key"))."
    echo "Subagents use the Claude account that was signed in when the token was made${acct:+ ($acct)}."
    return
  done
  if [ -n "$saved" ]; then echo "Stopped the Claude step after 3 tries. Your saved token is unchanged. Run $(rerun_cmd) again to retry."
  else echo "Stopped the Claude step after 3 tries. No token is saved. Run $(rerun_cmd) again to retry."; fi
}

# Removes the image machine so nothing keeps running, or says how to.
coordinator_cleanup() {
  if npx --yes instabox@latest rm --yes "$1" </dev/null >/dev/null 2>&1; then
    echo "Removed the image machine $1." >&2
  else
    echo "The image machine $1 may still be running. Remove it with: npx instabox@latest rm $1 (it also deletes itself after a while)." >&2
  fi
}

# Optional: cloud coordinators. Builds the image machine, opens the Claude sign-in on it, and saves the snapshot.
setup_coordinators() {
  local root=$1 snap marker out name rc=0 acct
  snap=$(get_saved CLAUDE_CLOUD_COORDINATOR_SNAPSHOT)
  marker=$(get_saved CLAUDE_CLOUD_SNAPSHOT_ACCOUNT)
  if [ -n "$snap" ]; then
    STATUS_COORD="ready${marker:+ ($marker)}"
    if [ -n "$marker" ] && [ -n "$LOCAL_ACCOUNT" ] && [ "$marker" != "$LOCAL_ACCOUNT" ]; then
      echo "Coordinators use $marker, but your local Claude is $LOCAL_ACCOUNT."
    fi
    yn "Cloud coordinators: an image is saved${marker:+ (account $marker)}. Replace it? Replacing it is how you move coordinators to another account." || return 0
  else
    yn "Set up cloud coordinators (they keep working when your laptop is closed)?" || return 0
  fi
  echo "Building the coordinator image machine (this can take a few minutes)..."
  out=$("$root/bin/claude-cloud" coordinator image 2>&1) || rc=$?
  name=$(printf '%s\n' "$out" | sed -n 's/^Image machine \([^ ]*\) is ready.*/\1/p; s/.*already exists (\([^)]*\)).*/\1/p' | head -n 1)
  if [ -z "$name" ]; then
    printf '%s\n' "$out" | tail -n 5 >&2
    echo "Could not create the image machine. Run $(rerun_cmd) again to retry." >&2
    STATUS_COORD="failed (run $(rerun_cmd) again)"; return 0
  fi
  echo "Image machine $name is ready."
  echo "Opening the Claude sign-in on it. A browser opens; sign in with the account coordinators should use."
  if ! npx --yes instabox@latest ssh "$name" -- -t claude auth login; then
    echo "The sign-in on the image machine did not finish." >&2
    coordinator_cleanup "$name"
    STATUS_COORD="failed (run $(rerun_cmd) again)"; return 0
  fi
  acct=$(npx --yes instabox@latest ssh "$name" -- claude auth status </dev/null 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s.slice(s.indexOf("{")));console.log(j.email||(j.account&&j.account.email)||"")}catch{console.log("")}})' 2>/dev/null) || acct=""
  if ! "$root/bin/claude-cloud" coordinator image --save; then
    echo "Saving the image failed. To retry: $root/bin/claude-cloud coordinator image --save" >&2
    coordinator_cleanup "$name"
    STATUS_COORD="failed (run $(rerun_cmd) again)"; return 0
  fi
  if [[ $acct =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]]; then write_env CLAUDE_CLOUD_SNAPSHOT_ACCOUNT "$acct"; else acct=""; del_env CLAUDE_CLOUD_SNAPSHOT_ACCOUNT; fi
  STATUS_COORD="ready${acct:+ ($acct)}"
  echo "Coordinator image saved."
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
    GH_RESULT="not confirmed"; return
  fi
  if [ "$state" = yes ]; then
    GH_RESULT="OK (GH_TOKEN stored in Instabox)"
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
    echo "GH_TOKEN is not visible to your Instabox API key. The Instabox CLI may be signed in to a different account or workspace: check with npx instabox@latest whoami, then run $(rerun_cmd) again." >&2
    exit 1
  fi
  if [ "$state" = yes ]; then GH_RESULT="OK (GH_TOKEN stored in Instabox)"
  else GH_RESULT="not confirmed"; echo "Could not confirm GH_TOKEN (could not read your Instabox orgs). Check with: npx --yes instabox@latest secrets ls"; fi
}

# Optional: a provider key for open-model workers (profiles glm, deepseek, particle, openrouter).
setup_provider() { # setup_provider NAME LABEL WHERE
  local name=$1 label=$2 where=$3 saved key
  saved=$(get_saved "$name")
  if [ -n "$saved" ]; then
    yn "$label key: saved ($(mask "" "$saved")). Replace it?" || return 0
  fi
  drain_tty
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
  echo "Step 1 of 4: tools"
  check_prereqs || exit 1
  [ "${1:-}" = --check-only ] && exit 0

  trap 'cleanup_capture; stty echo 2>/dev/null' EXIT
  trap 'exit 130' INT TERM

  local root branch sha log
  root=$(cd "$(dirname "$0")" && pwd)
  log=$(mktemp)
  (cd "$root" && npm install --silent --no-audit --no-fund) >"$log" 2>&1 || { cat "$log" >&2; rm -f "$log"; echo "npm install failed." >&2; exit 1; }
  rm -f "$log"
  link_command "$root"
  LOCAL_ACCOUNT=$(claude_account)
  [ -z "$LOCAL_ACCOUNT" ] || echo "Your local Claude: $LOCAL_ACCOUNT"

  warn_shell_env INSTABOX_API_KEY
  warn_shell_env CLAUDE_CODE_OAUTH_TOKEN
  echo; echo "Step 2 of 4: Instabox key"
  setup_instabox
  [ -n "$(get_saved INSTABOX_API_KEY)" ] || { echo "No Instabox key is saved, so setup cannot continue. Run $(rerun_cmd) again."; exit 1; }
  echo; echo "Step 3 of 4: Claude token"
  setup_claude
  echo; echo "Step 4 of 4: GitHub token, optional keys and coordinators"
  setup_github
  STATUS_GH=${GH_RESULT:-"not confirmed"}
  setup_provider PARTICLE_API_KEY Particle.ai https://platform.particle.ai
  setup_provider OPENROUTER_API_KEY OpenRouter https://openrouter.ai/keys
  setup_coordinators "$root"

  branch=$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null)
  sha=$(git -C "$root" rev-parse --short HEAD 2>/dev/null)
  cat <<MSG

Summary
  Instabox key       $STATUS_INSTABOX
  Claude token       $STATUS_CLAUDE
  GitHub token       $STATUS_GH
  Coordinators       $STATUS_COORD

claude-cloud runs from $root (branch $branch at $sha).
To change a key later, run: claude-cloud setup
To update: git -C $root pull && npm --prefix $root install
Restart any open claude-cloud session to use the new keys.

Recommended: block direct pushes to your main branch on GitHub (Settings > Rules > Rulesets). Subagents can push to any branch the token reaches.

Next, in a repo with a github.com origin, run:
  claude-cloud
then type: use a subagent to run hostname, write it to proof.txt, commit and push, and tell me the result
MSG
}

[ "${BASH_SOURCE[0]}" = "$0" ] && main "$@"
