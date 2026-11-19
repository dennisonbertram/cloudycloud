#!/usr/bin/env bash
# Sets up cloudy-cloud: checks tools, links the command, and asks for the keys the first agent run needs (--more adds the rest).
# Run it from a clone, in a terminal: ./install.sh
# Secrets are handled with shell builtins only (read, printf) and never appear in argv.

API=https://api.instabox.sh
DASH=https://dashboard.instabox.sh/dashboard/api-keys

# ---- how it looks -------------------------------------------------------------------------
# Colours, marks, spinner and boxes appear only on a colour terminal. Piped output, NO_COLOR,
# CLICOLOR=0 and TERM=dumb give plain text with ASCII marks. Messages are the same either way.
ui_init() {
  UI=0; UTF=0; WIDE=0; COLS=80; SPIN_PID=""; SPIN_T=""; SPIN_T0=0; HIDDEN=0; INTRO_TTY=""; SPIN_TTY=""
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ] && [ "${CLICOLOR:-}" != 0 ]; then UI=1; fi
  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) UTF=1 ;; esac
  COLS=$(tput cols 2>/dev/null) || COLS=${COLUMNS:-80}
  case $COLS in ''|*[!0-9]*) COLS=80 ;; esac
  [ "$COLS" -ge 20 ] || COLS=80
  C_ACC=""; C_DIM=""; C_OK=""; C_WARN=""; C_ERR=""; C_B=""; C_X=""
  M_OK="[ok]"; M_BAD="[x]"; M_WARN="!"; M_HINT=">"
  if [ "$UI" = 1 ]; then
    C_B=$'\e[1m'; C_X=$'\e[0m'
    if [ "$(tput colors 2>/dev/null || echo 8)" -ge 256 ]; then
      WIDE=1
      C_ACC=$'\e[38;5;75m'; C_DIM=$'\e[38;5;245m'; C_OK=$'\e[38;5;42m'; C_WARN=$'\e[38;5;214m'; C_ERR=$'\e[38;5;203m'
    else
      C_ACC=$'\e[36m'; C_DIM=$'\e[2m'; C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'
    fi
    [ "$UTF" = 0 ] || { M_OK="✔"; M_BAD="✖"; M_WARN="▲"; M_HINT="›"; }
  fi
}
ui_init

# Status lines: ok / bad / warn TEXT [DETAIL], hint TEXT. Callers add >&2 where the old message went to stderr.
ui_line() { printf '  %s%s%s %s' "$1" "$2" "$C_X" "$3"; [ -z "${4:-}" ] || printf '  %s%s%s' "$C_DIM" "$4" "$C_X"; printf '\n'; }
ok() { ui_line "$C_OK" "$M_OK" "$@"; }
bad() { ui_line "$C_ERR" "$M_BAD" "$@"; }
warn() { ui_line "$C_WARN" "$M_WARN" "$@"; }
hint() { printf '  %s%s %s%s\n' "$C_DIM" "$M_HINT" "$1" "$C_X"; }

# step N TITLE: a section line with progress, for example "●━━○━━○━━○  Tools" (plain: "[1/4] Tools").
step() {
  local i bar=""
  echo
  if [ "$UI" = 1 ] && [ "$UTF" = 1 ]; then
    for i in 1 2 3 4; do
      [ -z "$bar" ] || { if [ "$i" -le "$1" ]; then bar="$bar${C_ACC}━━"; else bar="$bar${C_DIM}━━"; fi; }
      if [ "$i" -le "$1" ]; then bar="$bar${C_ACC}●"; else bar="$bar${C_DIM}○"; fi
    done
    printf '  %s%s  %s%s%s\n' "$bar" "$C_X" "$C_B" "$2" "$C_X"
  else
    printf '[%s/4] %s\n' "$1" "$2"
  fi
}

# ask QUESTION [HINT...]: the heading of a question that is answered on the next line, one dim line per hint.
ask() { printf '  %s?%s %s%s%s\n' "$C_ACC" "$C_X" "$C_B" "$1" "$C_X"; shift; while [ $# -gt 0 ]; do printf '    %s%s%s\n' "$C_DIM" "$1" "$C_X"; shift; done; }
# ask_line PROMPT: the line the answer is typed on.
ask_line() { printf '  %s%s%s %s ' "$C_ACC" "$M_HINT" "$C_X" "$1"; }

# Spinner for a wait. Use spin_start before and spin_stop after, never while a prompt is open.
spin_start() { # spin_start TEXT
  SPIN_T=""; SPIN_T0=$SECONDS
  if [ "$UI" != 1 ]; then hint "$1..."; return; fi
  SPIN_MSG=$1
  stty -echo </dev/tty 2>/dev/null && SPIN_TTY=1
  printf '\e[?25l' >&2; HIDDEN=1
  (
    local f i=0 t
    if [ "$UTF" = 1 ]; then f=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏); else f=('|' '/' '-' '\'); fi
    while :; do
      t=$((SECONDS - SPIN_T0))
      printf '\r\e[K  %s%s%s %s  %s%ss%s' "$C_ACC" "${f[i % ${#f[@]}]}" "$C_X" "${SPIN_MSG:0:$((COLS - 14))}" "$C_DIM" "$t" "$C_X"
      i=$((i + 1)); sleep 0.08
    done
  ) >&2 &
  SPIN_PID=$!
}
spin_stop() {
  local t=$((SECONDS - SPIN_T0))
  if [ -n "$SPIN_PID" ]; then
    { kill "$SPIN_PID"; wait "$SPIN_PID"; } 2>/dev/null
    SPIN_PID=""
    printf '\r\e[K\e[?25h' >&2; HIDDEN=0
    [ -z "$SPIN_TTY" ] || stty echo </dev/tty 2>/dev/null
    SPIN_TTY=""
    [ "$t" -lt 1 ] || SPIN_T="${t}s"
  fi
}

# Restores the terminal: spinner, input mode, cursor and colours. Safe to call twice.
ui_cleanup() {
  spin_stop
  [ -z "$INTRO_TTY" ] || { stty "$INTRO_TTY" </dev/tty 2>/dev/null; INTRO_TTY=""; }
  if [ "$UI" = 1 ]; then
    [ "$HIDDEN" = 0 ] || printf '\e[?25h'
    printf '\e[0m'
  fi
  HIDDEN=0
}

# Boxes. box_open TITLE; box_row COLOR MARK LABEL VALUE; box_text TEXT [COLOR]; box_close. Plain mode: a heading and indented lines.
box_open() {
  BOX_TITLE=$1; BW=$COLS; [ "$BW" -le 78 ] || BW=78
  BOX_ASCII=0; [ "$UTF" = 1 ] || BOX_ASCII=1
  if [ "$UI" != 1 ]; then printf '\n%s\n' "$1"; return; fi
  local fill n=$((BW - 5 - ${#1}))
  printf -v fill '%*s' "$n" ''
  if [ "$UTF" = 1 ]; then printf '\n  %s╭─ %s%s%s%s %s╮%s\n' "$C_DIM" "$C_X$C_B" "$1" "$C_X" "$C_DIM" "${fill// /─}" "$C_X"
  else printf '\n  %s+- %s%s%s%s %s+%s\n' "$C_DIM" "$C_X$C_B" "$1" "$C_X" "$C_DIM" "${fill// /-}" "$C_X"; fi
}
box_pad() { # box_pad STYLED PLAIN_LENGTH
  local pad=$((BW - 4 - $2)) sp=""
  [ "$pad" -lt 0 ] && pad=0
  printf -v sp '%*s' "$pad" ''
  if [ "$UTF" = 1 ]; then printf '  %s│%s %s%s %s│%s\n' "$C_DIM" "$C_X" "$1" "$sp" "$C_DIM" "$C_X"
  else printf '  %s|%s %s%s %s|%s\n' "$C_DIM" "$C_X" "$1" "$sp" "$C_DIM" "$C_X"; fi
}
box_fit() { # box_fit TEXT: TEXT cut to the inner width
  local max=$((BW - 4))
  if [ "${#1}" -le "$max" ]; then printf '%s' "$1"; else printf '%s…' "${1:0:$((max - 1))}"; fi
}
box_row() {
  local color=$1 mark=$2 label=$3 value=$4 lab room
  if [ "$UI" != 1 ]; then printf '  %-15s %s\n' "$label" "$value"; return; fi
  printf -v lab '%-15s' "$label"
  room=$((BW - 4 - ${#mark} - 2 - 15))
  [ "${#value}" -le "$room" ] || value="${value:0:$((room - 1))}…"
  box_pad "$color$mark$C_X  $lab $C_DIM$value$C_X" $((${#mark} + 2 + 15 + 1 + ${#value}))
}
box_text() {
  local t
  if [ "$UI" != 1 ]; then printf '  %s\n' "$1"; return; fi
  t=$(box_fit "$1")
  box_pad "${2:-}$t$C_X" "${#t}"
}
box_close() {
  [ "$UI" = 1 ] || return 0
  local fill
  printf -v fill '%*s' "$((BW - 2))" ''
  if [ "$UTF" = 1 ]; then printf '  %s╰%s╯%s\n' "$C_DIM" "${fill// /─}" "$C_X"; else printf '  %s+%s+%s\n' "$C_DIM" "${fill// /-}" "$C_X"; fi
}

# The banner: three rows of ASCII clouds that drift in and settle, a blank row, then the wordmark (6 rows).
# Cloud art is CLk_ROW; CX is each cloud's final column, CD how far it starts away (the sign is the direction).
CL0_0='   .-.   '; CL0_1=' .(   ). '; CL0_2='(___.___)'
CL1_0='      .---.      '; CL1_1='  .-(      ).-.  '; CL1_2=' (___.___)_____) '
CL2_0='    .--.   '; CL2_1=' .-(    ).'; CL2_2='(___.__)__)'
CX=(4 21 46); CD=(-16 22 -24); CC=(far near far)
WORD0='█▀▀ █   █▀█ █ █ █▀▄ █▄█   █▀▀ █   █▀█ █ █ █▀▄'
WORD1='█▄▄ █▄▄ █▄█ █▄█ █▄▀  █    █▄▄ █▄▄ █▄█ █▄█ █▄▀'
BANNER_ROWS=6; BANNER_LAST=13
# banner_frame N: draws the banner for frame N; any N >= BANNER_LAST is the final picture. Every row is cleared to its end.
banner_frame() {
  local n=$1 r k i x v art c line prev left near far edge
  local buf col shades=(33 33 39 39 45 45 81 81 87 87 123 123)
  [ "$n" -le "$BANNER_LAST" ] || n=$BANNER_LAST
  left=$(( (BANNER_LAST - n) * (BANNER_LAST - n) )) # 169 at the start, 0 at the end: clouds slow down as they settle
  near=$C_X; far=$C_DIM; [ "$WIDE" = 0 ] || { near=$'\e[38;5;255m'; far=$'\e[38;5;244m'; }
  for r in 0 1 2; do
    buf=(); col=()
    for ((i = 0; i < 58; i++)); do buf[i]=" "; col[i]=""; done
    for k in 0 1 2; do
      v=CL${k}_$r; art=${!v}; x=$(( CX[k] + CD[k] * left / 169 ))
      for ((i = 0; i < ${#art}; i++)); do
        c=${art:i:1}
        [ "$c" != " " ] && [ "$((x + i))" -ge 0 ] && [ "$((x + i))" -lt 58 ] || continue
        buf[x + i]=$c; if [ "${CC[k]}" = near ]; then col[x + i]=$near; else col[x + i]=$far; fi
      done
    done
    line="  "; prev=""
    for ((i = 0; i < 58; i++)); do
      [ "${buf[i]}" = " " ] || [ "${col[i]}" = "$prev" ] || { line="$line${col[i]}"; prev=${col[i]}; }
      line="$line${buf[i]}"
    done
    printf '%s%s\e[K\n' "$line" "$C_X"
  done
  printf '\e[K\n'
  edge=$((n * 4)) # the wordmark is revealed from the left, 4 columns per frame
  for r in 0 1; do
    v=WORD$r; art=${!v}; line="  "; prev=""
    for ((i = 0; i < ${#art}; i++)); do
      c=${art:i:1}
      if [ "$c" = " " ] || [ "$i" -ge "$edge" ]; then line="$line "; continue; fi
      if [ "$WIDE" = 1 ]; then v=$'\e[38;5;'"${shades[i * 12 / ${#art}]}m"; else v=$C_ACC; fi
      [ "$v" = "$prev" ] || { line="$line$v"; prev=$v; }
      line="$line$c"
    done
    printf '%s%s\e[K\n' "$line" "$C_X"
  done
}

DESCRIPTION="Checks your tools, links the command and saves your keys."
# banner: the animated logo on a real terminal; a one-line title otherwise. Any key skips the animation.
banner() {
  if [ "$UI" != 1 ]; then printf 'Cloudy Cloud setup\n%s\n' "$DESCRIPTION"; return; fi
  if [ "$UTF" != 1 ] || [ "$COLS" -lt 60 ]; then
    printf '\n  %s%s%s %scloudy-cloud%s  setup\n  %s%s%s\n' "$C_ACC" "$([ "$UTF" = 1 ] && echo ◆ || echo '*')" "$C_X" "$C_B" "$C_X" "$C_DIM" "$DESCRIPTION" "$C_X"
    return
  fi
  echo
  if [ -n "${CI:-}" ] || [ "${CLOUDY_CLOUD_NO_ANIMATION:-}" = 1 ] || ! { : </dev/tty; } 2>/dev/null; then
    banner_frame 99
  else
    local s n
    INTRO_TTY=$(stty -g </dev/tty 2>/dev/null) || INTRO_TTY=""
    stty -echo -icanon min 0 time 1 </dev/tty 2>/dev/null
    printf '\e[?25l'; HIDDEN=1
    for s in 0 1 2 3 4 5 6 7 8 9 10 11 12 13; do
      [ "$s" = 0 ] || printf '\e[%sA' "$BANNER_ROWS"
      banner_frame "$s"
      # Waits up to 0.1 s for a key: that is both the frame delay and the skip check.
      n=$(dd bs=1 count=1 </dev/tty 2>/dev/null | wc -c)
      if [ "$((n))" -gt 0 ]; then printf '\e[%sA' "$BANNER_ROWS"; banner_frame 99; break; fi
    done
    drain_tty # while echo is still off and input is unbuffered, so a leftover key is neither shown nor kept
    [ -z "$INTRO_TTY" ] || stty "$INTRO_TTY" </dev/tty 2>/dev/null
    INTRO_TTY=""
    printf '\e[?25h'; HIDDEN=0
  fi
  printf '  %s%s%s\n' "$C_DIM" "$DESCRIPTION" "$C_X"
}

cfg() { printf '%s' "${CLOUDY_CLOUD_CONFIG:-$HOME/.config/cloudy-cloud/env}"; }

# The ChatGPT login file, resolved like codexAuth in src/harness-codex.mjs: CLOUDY_CLOUD_CODEX_AUTH first, then the config folder.
codex_auth_file() { printf '%s' "${CLOUDY_CLOUD_CODEX_AUTH:-$(dirname "$(cfg)")/codex-auth.json}"; }

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
  printf '  %s?%s %s%s%s %s[y/N]%s ' "$C_ACC" "$C_X" "$C_B" "$1" "$C_X" "$C_DIM" "$C_X" >&2
  IFS= read -r a </dev/tty || a=""
  [[ $a == [yY]* ]]
}

yn_strict() { # yn_strict QUESTION: default no; only exactly y or yes (any case, trimmed) counts
  local a
  drain_tty
  printf '  %s?%s %s%s%s %s[y/N]%s ' "$C_ACC" "$C_X" "$C_B" "$1" "$C_X" "$C_DIM" "$C_X" >&2
  IFS= read -r a </dev/tty || a=""
  a=${a#"${a%%[![:space:]]*}"}; a=${a%"${a##*[![:space:]]}"}
  case $a in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

yn_yes() { # yn_yes QUESTION: default yes
  local a
  drain_tty
  printf '  %s?%s %s%s%s %s[Y/n]%s ' "$C_ACC" "$C_X" "$C_B" "$1" "$C_X" "$C_DIM" "$C_X" >&2
  IFS= read -r a </dev/tty || a=""
  [[ $a != [nN]* ]]
}

# ---- Instabox proxy secrets: a key stored this way never reaches a worker machine, only a placeholder ----
# secret_hosts NAME: the hosts a key may be sent to (from the proxy spike, #63). Fails for any other name.
secret_hosts() {
  case $1 in
    CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY) echo api.anthropic.com ;;
    PARTICLE_API_KEY) echo api.particle.ai ;;
    OPENROUTER_API_KEY) echo openrouter.ai ;;
    OPENAI_API_KEY) echo api.openai.com ;;
    CLOUDY_CLOUD_INSTABOX_API_KEY) echo api.instabox.sh ;;
    *) return 1 ;;
  esac
}

# eff NAME: the value the runtime uses (loadEnv): the shell's when set, else the saved one.
eff() { printf '%s' "${!1:-$(get_saved "$1")}"; }

# msb_bin: the microsandbox CLI — CLOUDY_CLOUD_MSB_BIN (shell, then saved) wins, then an executable
# ~/.local/bin/msb, then msb on PATH. Prints nothing when none is found.
msb_bin() {
  local b; b=$(eff CLOUDY_CLOUD_MSB_BIN)
  if [ -z "$b" ]; then
    if [ -x "$HOME/.local/bin/msb" ]; then b=$HOME/.local/bin/msb
    elif command -v msb >/dev/null 2>&1; then b=$(command -v msb); fi
  fi
  printf '%s' "$b"
}

is_proxied() { case ",$(get_saved CLOUDY_CLOUD_PROXY_SECRETS)," in *",$1,"*) return 0 ;; esac; return 1; }

# ibx_npx ARGS: the instabox CLI through npx, run from a trusted directory with only PATH, HOME, the proxy/CA
# variables and INSTABOX_API_KEY. npm reads the checkout's .npmrc (registry, scripts) and every npm_config_* the
# caller exported, so run from the temp directory, not the repository, and pass nothing else of the environment.
ibx_npx() {
  local e=(PATH="$PATH" HOME="$HOME") v
  for v in TERM LANG LC_ALL USER TMPDIR HTTPS_PROXY https_proxy HTTP_PROXY http_proxy NO_PROXY no_proxy NODE_EXTRA_CA_CERTS INSTABOX_API_KEY; do
    [ -n "${!v:-}" ] && e+=("$v=${!v}")
  done
  ( cd "${TMPDIR:-/tmp}" 2>/dev/null || cd /tmp || return
    env -i "${e[@]}" npx --yes instabox@latest "$@" )
}

# store_secret NAME VALUE: stores VALUE as an Instabox secret limited to NAME's hosts (the value goes on stdin, never argv),
# records NAME in CLOUDY_CLOUD_PROXY_SECRETS and removes any NAME= line from the config. Needs your instabox login session.
store_secret() {
  local name=$1 h cur args=()
  for h in $(secret_hosts "$name") ; do args+=(--host "$h"); done
  [ "${#args[@]}" -gt 0 ] || return 1
  ibx_npx whoami >/dev/null 2>&1 || ibx_npx login </dev/tty || return 1
  printf '%s' "$2" | ibx_npx secrets set "$name" "${args[@]}" >/dev/null || return 1
  # The runtime reads secrets in the org of INSTABOX_API_KEY; your login may point at another org or workspace
  # (instabox secrets set uses --org, else your default workspace). Keep the env line unless the API-key org shows the secret.
  secret_visible "$name" || { warn "$name is not visible to your Instabox API key (your login may use another org or workspace), so it is not treated as stored" "check with: npx --yes instabox@latest whoami" >&2; return 1; }
  if ! is_proxied "$name"; then cur=$(get_saved CLOUDY_CLOUD_PROXY_SECRETS); write_env CLOUDY_CLOUD_PROXY_SECRETS "${cur:+$cur,}$name" || return 1; fi
  del_env "$name" || { warn "Stored $name, but could not remove its line from $(cfg)" "delete the $name= line yourself" >&2; return 1; }
}

# secret_visible NAME: the org of the saved Instabox API key lists NAME with all of its hosts.
secret_visible() {
  secrets_list | node -e '
    const [name,...hosts]=process.argv.slice(1);let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);
    const a=Array.isArray(j)?j:(j.items||j.data||j.secrets||[]);
    process.exit(a.some(x=>x&&x.name===name&&hosts.every(h=>(x.hosts||[]).includes(h)))?0:1)}catch{process.exit(1)}})' "$1" $(secret_hosts "$1")
}

# keep_key NAME VALUE: on Instabox, stores the key as a secret; if that fails (or on your own machine), saves it in the config instead.
keep_key() {
  if [ "${PROVIDER:-}" = instabox ] && secret_hosts "$1" >/dev/null; then
    if store_secret "$1" "$2"; then return 0; fi
    warn "Could not store $1 as an Instabox secret, so it is saved in $(cfg) instead" "run $(rerun_cmd)$(more_key "$1" && printf ' --more') again to retry" >&2
  fi
  write_env "$1" "$2" || { bad "Could not write $(cfg)." >&2; exit 1; }
}

# migrate_key NAME: asks to move a key that sits in the config file into an Instabox secret. A no changes nothing.
migrate_key() {
  local v
  [ "${PROVIDER:-}" = instabox ] || return 1
  v=$(get_saved "$1"); [ -n "$v" ] || return 1
  yn_yes "Move $1 into an Instabox secret (host $(secret_hosts "$1"))?" || { hint "Kept $1 in $(cfg). On Instabox, workers that need it are refused until it is stored as a secret."; return 1; }
  if store_secret "$1" "$v"; then ok "Moved $1 into an Instabox secret" "workers see a placeholder"
  else warn "Could not store $1 as an Instabox secret; it stays in $(cfg)" "run $(rerun_cmd)$(more_key "$1" && printf ' --more') again to retry"; return 1; fi
}

# check_proxy_secrets: every name in CLOUDY_CLOUD_PROXY_SECRETS must exist in the org, with the hosts of the profiles that use it.
check_proxy_secrets() { # optional $1: the Instabox key
  local names n pairs=() root rc
  names=$(eff CLOUDY_CLOUD_PROXY_SECRETS); [ -n "$names" ] || return 0
  root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  for n in ${names//,/ }; do pairs+=("$n=$(secret_hosts "$n" 2>/dev/null)"); done
  secrets_list "${1:-}" | node --input-type=module -e '
    const root=process.argv[1];let s="";process.stdin.on("data",d=>s+=d).on("end",async()=>{
    let list;try{const j=JSON.parse(s);list=Array.isArray(j)?j:(j.items||j.data||j.secrets||[])}catch{console.log("  Could not read your Instabox secrets.\n  Check: npx --yes instabox@latest secrets ls");process.exit(2)}
    let profiles={};try{profiles=(await import(root+"/src/profiles.mjs")).loadProfiles()}catch{}
    let bad=0;
    const show=(cmd)=>{const [base,...hosts]=cmd.split(" --host ");let line="  "+base;
      for(const h of hosts){const seg=" --host "+h;if(line.length+seg.length>78){console.log(line+" \\");line="    "+seg}else line+=seg}
      console.log(line)};
    for(const pair of process.argv.slice(2)){
      const [name,fixed]=[pair.slice(0,pair.indexOf("=")),pair.slice(pair.indexOf("=")+1)];
      const need=new Set(fixed?[fixed]:[]);
      for(const p of Object.values(profiles))if(p&&p.keyName===name){try{need.add(new URL(p.baseUrl).host)}catch{}}
      const cmd="npx --yes instabox@latest secrets set "+name+[...need].map(h=>" --host "+h).join("");
      const have=list.find(x=>x&&x.name===name);
      if(!have){bad=1;console.log("  "+name+" is not an Instabox secret. Fix:");show(cmd);continue}
      const miss=[...need].filter(h=>!(have.hosts||[]).includes(h));
      if(miss.length){bad=1;console.log("  "+name+" is missing host "+miss.join(", ")+".");console.log("  Paste the key again:");show(cmd)}
      else console.log("  "+name+" is stored with its hosts.")}
    process.exit(bad)})' "$root" "${pairs[@]}"
  rc=$?
  return $rc
}

# check_setup: setup --check-only. Runs every check without asking or changing anything, and ends with a verdict.
# Exit status is 1 when something needs fixing; warnings (a check that could not run) do not fail it.
check_setup() {
  local fails=0 more= setupfix= coord_hint= cps code state host provider key st org pct pset ov cap prov="" root msb v egerr egv l rc=0
  root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  [ -z "${PREREQ_FAIL:-}" ] || { fails=1; setupfix=1; }
  provider=$(eff CLOUDY_CLOUD_PROVIDER)
  [ "$provider" = self-hosted ] && prov=" --provider self-hosted"
  step 2 "Provider"
  if [ "$provider" = microsandbox ]; then
    msb=$(msb_bin)
    if [ -z "$msb" ]; then
      bad "The microsandbox CLI (msb) was not found"; fails=1
      hint "Install it: curl -fsSL https://install.microsandbox.dev | sh"
      hint "or add CLOUDY_CLOUD_MSB_BIN=<its full path> to $(cfg)."
    elif ! MSB_BACKEND=local "$msb" --version >/dev/null 2>&1; then
      bad "The microsandbox CLI does not run" "$msb"; fails=1
    elif ! MSB_BACKEND=local "$msb" ls >/dev/null 2>&1; then
      bad "The microsandbox backend does not answer" "see why: $msb ls"; fails=1
    else
      ok "The microsandbox CLI works" "$msb"
      v=$(sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' "$root/package.json")
      if [ -n "$v" ] && MSB_BACKEND=local "$msb" image inspect "cloudy-cloud-worker:$v" >/dev/null 2>&1; then
        ok "The worker image cloudy-cloud-worker:$v is loaded"
      else
        bad "The worker image cloudy-cloud-worker:${v:-?} is not loaded"; fails=1
        hint "Build and load it (needs Docker); see \"Run on this computer"
        hint "with microsandbox\" in the README."
      fi
    fi
  elif [ "$provider" = self-hosted ]; then
    host=$(eff CLOUDY_CLOUD_SSH_HOST)
    if [ -n "$host" ]; then ok "Your own machine is set to $host"; else bad "No SSH host is saved for your own machine"; fails=1; setupfix=1; fi
  else
    key=$(eff INSTABOX_API_KEY)
    if [ -z "$key" ]; then bad "No Instabox key is saved"; fails=1; setupfix=1
    else
      code=$(http_code "$key")
      case $code in
        200) ok "Instabox key works"
          read -r st org pct pset ov cap <<<"$(alerts_state "$key")"
          alerts_report "$st" "$org" "$pct" "$ov" "$cap" || {
            warn "Instabox usage alert emails are off"
            hint "(usage alert: $([ "$pset" = yes ] && echo "$pct%" || echo off), overage alert: $ov, spend cap: $([ "$cap" = none ] && echo none || echo "\$$cap"))"
            hint "Turn them on in setup --more."
            hint "Or: ${ALERTS_FIX/ORG/$org}"
          } ;;
        401|403) bad "Instabox rejected the saved key (HTTP $code)"; fails=1; setupfix=1 ;;
        *) warn "Could not check the Instabox key" "no answer from the Instabox API" ;;
      esac
    fi
  fi
  step 3 "Claude token"
  local n name="" lit="" cname="" any=""
  if [ "$provider" = microsandbox ]; then
    # Every credential is a local value: microsandbox swaps it into matching requests itself, so no proxy secrets.
    for n in CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY; do [ -z "$cname" ] && [ -n "$(eff $n)" ] && cname=$n; done
    for n in OPENAI_API_KEY PARTICLE_API_KEY OPENROUTER_API_KEY; do [ -n "$(eff $n)" ] && any=1; done
    if agents_has claude; then
      if [ -n "$cname" ]; then ok "A Claude credential is saved" "the value stays on this computer"
      else bad "No Claude token is saved, so subagents cannot sign in"; fails=1
        hint "Add CLAUDE_CODE_OAUTH_TOKEN=<your Claude token> to $(cfg);"
        hint "microsandbox puts it only into requests to api.anthropic.com."
      fi
    elif [ -n "$cname" ] || [ -n "$any" ]; then ok "A worker credential is saved" "the value stays on this computer"
    elif [ -f "$(codex_auth_file)" ]; then ok "A Codex sign-in is saved" "it is copied onto each machine"
    else bad "No worker credential is saved, so cloud_agent has no profile it can use"; fails=1
      hint "Add a key to $(cfg): OPENAI_API_KEY, PARTICLE_API_KEY or"
      hint "OPENROUTER_API_KEY (or a Claude token)."
    fi
  elif ! agents_has claude; then
    ok "No Claude token is needed" "agents: $AGENTS"
    # Without a Claude token every worker needs a profile, and a profile needs one of these credentials.
    local usable="" plain=""
    for n in OPENAI_API_KEY PARTICLE_API_KEY OPENROUTER_API_KEY; do
      if is_proxied $n || { [ "$provider" = self-hosted ] && [ -n "$(eff $n)" ]; }; then usable=1
      elif [ -n "$(eff $n)" ]; then plain=${plain:-$n}; fi
    done
    [ -f "$(codex_auth_file)" ] && usable=1
    for n in CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY; do # an unprofiled Claude worker uses the first Claude credential with a value or a proxy secret, as the runtime does
      [ -n "$(eff $n)" ] || is_proxied $n || continue
      if is_proxied $n || [ "$provider" = self-hosted ]; then usable=1; else plain=${plain:-$n}; fi
      break
    done
    if [ -n "$usable" ]; then ok "A worker credential is saved"
    elif [ -n "$plain" ]; then
      bad "$plain is a plain value, not a proxy secret"; fails=1
      hint "Instabox refuses to copy a real key to a machine."
      if more_key "$plain"; then
        more=1 setupfix=1
        hint "Store it as a proxy secret in setup --more."
      else
        hint "claude is not in your agents, so setup skips this key. Store it:"
        hint "printf %s \"\$$plain\" |"
        hint "npx --yes instabox@latest secrets set \\"
        hint "  $plain --host $(secret_hosts "$plain")"
        hint "then add it to CLOUDY_CLOUD_PROXY_SECRETS and delete the"
        hint "plain $plain= line in the env file."
      fi
    else
      bad "No worker credential is saved, so cloud_agent has no profile it can use"; fails=1 more=1 setupfix=1
      hint "Save a key in setup --more: OPENAI_API_KEY, PARTICLE_API_KEY or"
      hint "OPENROUTER_API_KEY. Or copy the Codex login file by hand:"
      hint "install -m 600 ~/.codex/auth.json \\"
      hint "  $(codex_auth_file)"
    fi
  else
  for n in CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY; do # the runtime uses the first one that has a value or a proxy secret
    if [ -z "$name" ] && { [ -n "$(eff $n)" ] || is_proxied $n; }; then name=$n; [ -z "$(eff $n)" ] || lit=1; fi
  done
  if [ -z "$name" ]; then bad "No Claude token is saved, so subagents cannot sign in"; fails=1; setupfix=1
  elif [ "$provider" != self-hosted ] && [ -n "$lit" ] && ! is_proxied "$name"; then
    bad "$name is a plain value, not a proxy secret"; fails=1; setupfix=1
    hint "Instabox refuses to copy a real key to a machine."
    hint "Rerun setup to store it as a proxy secret."
  else ok "A Claude credential is saved"; fi
  fi
  step 4 "GitHub token, secrets and coordinators"
  if [ "$provider" = microsandbox ]; then
    if [ -z "$(eff GH_TOKEN)" ]; then
      bad "GH_TOKEN is not saved, so subagents cannot push"; fails=1
      hint "Add GH_TOKEN=<a token with write access> to $(cfg);"
      hint "microsandbox puts it only into requests to github.com."
    else ok "GH_TOKEN is saved" "the value stays on this computer"; fi
    if [ -n "$(eff CLOUDY_CLOUD_EGRESS_ALLOW)" ] || grep -q '^CLOUDY_CLOUD_EGRESS_ALLOW=' "$(cfg)" 2>/dev/null; then
      # off|none (any case, optionally quoted) means no policy on purpose — the same opt-out the parser has.
      egv=$(eff CLOUDY_CLOUD_EGRESS_ALLOW | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
      case $egv in \"*\") egv=${egv#\"}; egv=${egv%\"} ;; \'*\') egv=${egv#\'}; egv=${egv%\'} ;; esac
      case $(printf '%s' "$egv" | tr 'A-Z' 'a-z') in
      off|none) ok "No egress allow list (turned off)" ;;
      *)
        if ! command -v node >/dev/null 2>&1; then warn "Could not check CLOUDY_CLOUD_EGRESS_ALLOW" "node is missing"
        else
          # Parse with src/config.mjs, then check each host with the provider's own rule (egressOk): a bare
          # IP literal parses as a host but upstream treats it as a bypass rule, so it is refused here too.
          egerr=$(CLOUDY_CLOUD_EGRESS_CHECK=$(eff CLOUDY_CLOUD_EGRESS_ALLOW) node --input-type=module -e '
            const { egressAllow } = await import(process.argv[1]);
            const { egressOk } = await import(process.argv[2]);
            const r = egressAllow({ CLOUDY_CLOUD_EGRESS_ALLOW: process.env.CLOUDY_CLOUD_EGRESS_CHECK });
            if (r.error) { console.log(r.error); process.exit(3); }
            const i = r.list.findIndex((h) => !egressOk(h));
            if (i !== -1) { console.log(`entry ${i + 1} is not a host microsandbox accepts (host names only — no IP literals or ports)`); process.exit(4); }' "file://$root/src/config.mjs" "file://$root/src/providers/microsandbox.mjs") && rc=0 || rc=$?
          if [ -n "$egerr" ]; then
            if [ "$rc" = 4 ]; then bad "CLOUDY_CLOUD_EGRESS_ALLOW names a host microsandbox cannot enforce"; else bad "CLOUDY_CLOUD_EGRESS_ALLOW does not parse"; fi
            fails=1
            while IFS= read -r l; do hint "$l"; done <<<"$egerr"
          elif [ "$rc" != 0 ]; then warn "Could not check CLOUDY_CLOUD_EGRESS_ALLOW" "node failed"
          else ok "The egress allow list parses" "microsandbox enforces it"; fi
        fi ;;
      esac
    else ok "No egress allow list is set" "workers get microsandbox's default network policy"; fi
  elif [ "$provider" = self-hosted ]; then
    if [ -z "$(eff GH_TOKEN)" ]; then bad "GH_TOKEN is not saved, so subagents cannot push"; fails=1; setupfix=1
    elif [ "$(eff CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX)" != yes ]; then
      bad "GH_TOKEN is not allowed on your own machine, so subagents cannot push"; fails=1; setupfix=1
      hint "Set CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX=yes to allow it"
    else ok "GH_TOKEN is saved and allowed on your own machine"; fi
  else
    state=$(gh_secret_state "$key")
    case $state in
      yes) ok "GH_TOKEN is stored in Instabox" ;;
      no) bad "GH_TOKEN is not stored in Instabox, so subagents cannot push"; fails=1; setupfix=1 ;;
      *) warn "Could not confirm GH_TOKEN" "check with: npx --yes instabox@latest secrets ls" ;;
    esac
    if [ -n "$(eff CLOUDY_CLOUD_COORDINATOR_SNAPSHOT)" ]; then ok "Coordinator image is saved"
    elif coordinators_offered; then hint "No coordinator image is set up (optional)."; coord_hint=1; fi
    cps=$(check_proxy_secrets "$key") || fails=1
    [ -z "$cps" ] || printf '%s\n' "$cps"
    while IFS= read -r l; do
      case $l in
        *"is not an Instabox secret"*|*"is missing host"*)
          l=${l#"${l%%[![:space:]]*}"}; n=${l%% *}
          case $n in
            GH_TOKEN) setupfix=1 ;;
            CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY) agents_has claude && setupfix=1 ;;
            *) more_key "$n" && { more=1; setupfix=1; } ;;
          esac ;;
      esac
    done <<<"$cps"
  fi
  echo
  if [ "$fails" = 0 ]; then ok "Check passed: nothing needs fixing"
  else bad "Check failed: fix the items above" "$([ -n "$setupfix" ] && printf 'run %s%s%s' "$(rerun_cmd)" "${more:+ --more}" "$prov")"; fi
  [ -z "$coord_hint" ] || [ "$fails" != 0 ] || hint "Run: $(rerun_cmd) --more"
  return "$fails"
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

stop_empty() { warn "Stopped. Run $(rerun_cmd) again to continue." >&2; exit 1; }

# AGENTS: the agents this setup is for, as a comma list (claude, codex, opencode, pi, free-pi). Saved as CLOUDY_CLOUD_AGENTS.
AGENTS=""
agents_has() { case ",$AGENTS," in *",$1,"*) return 0 ;; esac; return 1; }

check_prereqs() {
  local nope=0 v major
  command -v git >/dev/null || { bad "git is missing" "Install it: https://git-scm.com/downloads"; nope=1; }
  v=none
  command -v node >/dev/null && v=$(node -v 2>/dev/null)
  major=${v#v}; major=${major%%.*}
  if ! [[ $major =~ ^[0-9]+$ ]] || [ "$major" -lt 20 ]; then
    bad "Node.js 20 or later is needed (found $v)"; hint "Install it: https://nodejs.org"; nope=1
  fi
  command -v npm >/dev/null || { bad "npm is missing"; nope=1; }
  command -v curl >/dev/null || { bad "curl is missing"; nope=1; }
  # Claude Code is needed only when claude is a chosen agent (before the question, AGENTS is empty).
  if agents_has claude; then command -v claude >/dev/null || { bad "Claude Code is missing" "Install it: https://code.claude.com"; nope=1; }; fi
  return $nope
}

warn_shell_env() {
  [ -z "${!1:-}" ] || warn "$1 is also set in your shell" "cloudy-cloud uses the shell value, not the saved one"
}

# from_npm ROOT: true when this copy was installed by npm or npx (it sits inside node_modules) instead of cloned.
from_npm() { case $1 in */node_modules/*) return 0 ;; *) return 1 ;; esac; }

# install_global: npm install -g cloudycloud. An older global cloudy-cloud link (from the old package name, or an
# npm link of a git clone) makes npm fail with EEXIST, so offer to replace it. A failure never stops setup.
install_global() {
  local bin target out rc fix='npm rm -g cloudy-cloud && npm install -g cloudycloud'
  bin=$(npm prefix -g 2>/dev/null)/bin/cloudy-cloud
  if [ -L "$bin" ]; then
    target=$(readlink "$bin")
    case $target in
      */node_modules/cloudycloud/*) ;;
      *)
        ask "An older cloudy-cloud command is already installed" "$bin points to $target" \
          "It comes from the old package name cloudy-cloud, or from npm link on a git clone." \
          "npm cannot install over it. Replacing it removes only that link and package."
        if yn "Replace it (npm rm -g cloudy-cloud, then npm install -g cloudycloud)?"; then
          spin_start "Replacing the old cloudy-cloud command"
          [ -e "$bin" ] || rm -f "$bin" # a link to a package that is gone: npm rm would not remove it
          out=$(npm rm -g cloudy-cloud 2>&1 >/dev/null); rc=$?
          [ "$rc" -ne 0 ] || { out=$(npm install -g cloudycloud 2>&1 >/dev/null); rc=$?; }
          spin_stop
          install_global_done "$rc" "$out" "$fix"
        else
          warn "Left the old command in place. Run it with npx cloudycloud, or replace it later: $fix"
        fi
        return ;;
    esac
  fi
  spin_start "Installing cloudycloud"
  out=$(npm install -g cloudycloud 2>&1 >/dev/null); rc=$?
  spin_stop
  install_global_done "$rc" "$out" "$fix"
}

# install_global_done RC NPM_OUTPUT FIX_COMMAND
install_global_done() {
  local line
  if [ "$1" -eq 0 ]; then
    ok "Installed the cloudy-cloud command"
    command -v cloudy-cloud >/dev/null ||
      warn "Add this to your shell profile" "export PATH=\"$(npm prefix -g)/bin:\$PATH\""
    return
  fi
  line=$(printf '%s\n' "$2" | grep -v 'npm error code\|A complete log\|^npm error *$' | grep -m1 '[[:alnum:]]')
  bad "npm could not install the cloudy-cloud command" "${line#npm error }"
  hint "To fix it yourself, run: $3"
  hint "If that fails, check what is at $(npm prefix -g 2>/dev/null)/bin/cloudy-cloud, move it away yourself, then run: npm install -g cloudycloud"
  warn "Continuing without it. Run it with npx cloudycloud"
}

# real_path FILE: FILE with symlinks resolved.
real_path() { node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$1" 2>/dev/null || printf '%s\n' "$1"; }

# path_cloudy_cloud ROOT: the first cloudy-cloud on PATH that is not in npx's cache or ROOT's own node_modules (empty if none).
path_cloudy_cloud() {
  local c
  while IFS= read -r c; do
    case $c in */_npx/* | "${1%/node_modules/*}"/node_modules/*) continue ;; esac
    printf '%s\n' "$c"; return
  done < <(type -ap cloudy-cloud 2>/dev/null)
}

# is_npm_global_copy FILE: true when FILE resolves into the npm global modules folder's cloudycloud package.
is_npm_global_copy() {
  local mods
  mods=$(npm prefix -g 2>/dev/null)/lib/node_modules
  mods=$(cd "$mods" 2>/dev/null && pwd -P || printf '%s' "$mods")
  case $(real_path "$1") in "$mods/cloudycloud/"*) return 0 ;; *) return 1 ;; esac
}

link_command() { # link_command ROOT
  local root=$1 cur other old oldpkg
  if from_npm "$root"; then
    # An npx copy is a temporary cache folder, so the lasting command comes from a global npm install, never npm link.
    # npx puts its own temporary .bin first on PATH; a command found there (or inside this package's node_modules) is not installed.
    # Keep searching the rest of PATH, so a stale copy behind it is still found.
    cur=$(path_cloudy_cloud "$root")
    if [ -n "$cur" ]; then
      if ! is_npm_global_copy "$cur"; then
        if yn "cloudy-cloud on your PATH runs from $(dirname "$(real_path "$cur")" | sed 's|/bin$||'). Replace it with the npm global install?"; then
          install_global
          cur=$(path_cloudy_cloud "$root")
          if [ -n "$cur" ] && ! is_npm_global_copy "$cur"; then
            warn "cloudy-cloud on your PATH is still the old copy" "$cur"
            hint "Remove it ($cur), or put $(npm prefix -g 2>/dev/null)/bin first on your PATH"
          fi
        else
          warn "Left it in place. Replace it later: npm install -g cloudycloud"
        fi
      else
        ok "cloudy-cloud is already on your PATH" "$cur"
      fi
      return
    fi
    if yn_yes "Install the cloudy-cloud command globally (npm install -g cloudycloud)?"; then
      install_global
    else
      warn "Skipped. Run it with npx cloudycloud, or install later: npm install -g cloudycloud"
    fi
    return
  fi
  cur=$(command -v cloudy-cloud) || cur=""
  # npm link made a claude-cloud link that now dangles (this folder no longer has bin/claude-cloud). Remove only a broken link.
  old=$(npm prefix -g 2>/dev/null)/bin/claude-cloud
  if [ -L "$old" ] && [ ! -e "$old" ]; then
    rm -f "$old" && ok "Removed the old claude-cloud command link"
  fi
  # The npm package used to be named cloudy-cloud; drop that old global link so only the cloudycloud one remains.
  oldpkg=$(npm root -g 2>/dev/null)/cloudy-cloud
  [ -L "$oldpkg" ] && rm -f "$oldpkg"
  if [ -z "$cur" ]; then
    (cd "$root" && npm link >/dev/null) || { bad "npm link failed" >&2; exit 1; }
    ok "Linked the cloudy-cloud command"
    command -v cloudy-cloud >/dev/null ||
      warn "Add this to your shell profile" "export PATH=\"$(npm prefix -g)/bin:\$PATH\""
    return
  fi
  other=$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$cur")
  if [ "$other" = "$root/bin/cloudy-cloud" ]; then
    ok "cloudy-cloud already runs from this folder"
  else
    other=${other%/bin/cloudy-cloud}
    if yn "cloudy-cloud on your PATH runs from $other. Point it at this folder instead?"; then
      (cd "$root" && npm link >/dev/null) || { bad "npm link failed" >&2; exit 1; }
      ok "Linked the cloudy-cloud command to this folder"
    fi
  fi
}

KEYLEN=56   # length of an Instabox key: ibk_ plus 52 characters
TOKLEN=108  # usual length of a token from claude setup-token
STATUS_INSTABOX="not set up"; STATUS_CLAUDE="not set up"; STATUS_GH="not checked"; STATUS_COORD="not set up"
INCOMPLETE=""
LOCAL_ACCOUNT=""

# rerun_cmd: the command that runs setup again.
rerun_cmd() {
  if command -v cloudy-cloud >/dev/null 2>&1; then printf 'cloudy-cloud setup'
  elif from_npm "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; then printf 'npx cloudycloud setup'
  else printf './install.sh'; fi
}

# more_key NAME: true when NAME is a credential only setup --more asks for.
more_key() { case $1 in PARTICLE_API_KEY|OPENROUTER_API_KEY|OPENAI_API_KEY|CLOUDY_CLOUD_INSTABOX_API_KEY) return 0 ;; esac; return 1; }

# coordinators_offered: false where a local coordinator image cannot run here: self-hosted has its own
# coordinator flow, microsandbox has no coordinator support, and local coordinators use docker, not podman.
coordinators_offered() {
  case ${PROVIDER:-$(eff CLOUDY_CLOUD_PROVIDER)} in self-hosted|microsandbox) return 1 ;; esac
  [ "$(eff CLOUDY_CLOUD_CONTAINER_RUNTIME)" != podman ] || return 1
  command -v docker >/dev/null 2>&1 || ! command -v podman >/dev/null 2>&1
}

# strip_escapes TEXT: prints TEXT without terminal escape sequences and carriage returns.
strip_escapes() {
  local v=$1 re
  re=$'\e'"\\[[0-9;?]*[A-Za-z~]"
  while [[ $v =~ $re ]]; do v=${v/"${BASH_REMATCH[0]}"/}; done
  v=${v//$'\r'/}
  printf '%s' "$v"
}

del_env() { # del_env NAME: removes NAME from the config file, if present. Returns non-zero, leaving the file as it was, on any failure.
  local file t
  file=$(cfg); [ -f "$file" ] || return 0
  t="$file.tmp.$$"
  # grep exits 1 when no line is left, which is fine; 2 or more is an error.
  ( umask 077; grep -v "^$1=" "$file" > "$t"; [ $? -le 1 ] && [ -f "$t" ] && mv "$t" "$file" ) || { rm -f "$t"; return 1; }
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
      bad "Got $n of $KEYLEN characters, so it looks cut off." "Copy the whole key again; it may wrap onto two lines, which is fine to paste."
    else
      bad "That starts like an Instabox key${c:+ ($(preview "$c"))} but is not one." "It should be ibk_ followed by 52 letters a-z and digits 2-7."
    fi
  else
    bad "That does not look like an Instabox API key." "It should start with ibk_. Create one at $DASH."
  fi
  hint "The dashboard shows a key only once, when you create it. If you lost it, create a new one at $DASH."
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
      bad "Got $n of $TOKLEN characters, so it looks cut off." "Copy the whole token again; it may wrap onto two lines, which is fine to paste."
      PARSED=""; return 1
    fi
    return 0
  fi
  bad "That does not look like a token from claude setup-token." "It should start with sk-ant-oat01-. In another terminal run: claude setup-token"
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
  local f rc pid wd out reason secs=${CLOUDY_CLOUD_CHECK_SECONDS:-60}
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
  if [ "$(uname)" = Darwin ]; then script -q "$1" claude setup-token </dev/tty | mask_token
  else script -qc "claude setup-token" "$1" </dev/tty | mask_token; fi
}

# Shows claude setup-token's sign-in link and prompts as they arrive, with the token itself hidden.
# It works on chunks, not lines, so a prompt with no newline still appears. A token split across chunks is held back.
mask_token() {
  command -v perl >/dev/null 2>&1 || { sed -l 's/sk-ant-oat01-[A-Za-z0-9_-]*/sk-ant-oat01-(hidden)/g' 2>/dev/null || cat >/dev/null; return 0; }
  perl -e '
    $| = 1; my $b = ""; my $t = qr/sk-ant-oat01-[A-Za-z0-9_-]+/;
    while (sysread(STDIN, my $c, 4096)) {
      $b .= $c; my $h = "";
      if ($b =~ s/(sk-ant-oat01-[A-Za-z0-9_-]*|s(?:k(?:-(?:a(?:n(?:t(?:-(?:o(?:a(?:t(?:0(?:1)?)?)?)?)?)?)?)?)?)?)?)\z//) { $h = $1 }
      $b =~ s/$t/sk-ant-oat01-(hidden)/g; print $b; $b = $h;
    }
    $b =~ s/$t/sk-ant-oat01-(hidden)/g; print $b;'
}

# Makes the bundled skills available in every project. A clone gets links (git pull updates them);
# an npm copy gets real copies, because its folder is temporary. Leaves a different existing folder alone.
link_skill() {
  local root=$1 name dest
  mkdir -p "$HOME/.claude/skills" || return 0
  for name in cloud-fleet cloudy-cloud-setup; do
    dest="$HOME/.claude/skills/$name"
    if from_npm "$root"; then
      if [ -L "$dest" ]; then warn "Skill $name not copied: $dest is a link"; continue; fi
      if [ -d "$dest" ] && diff -r "$root/skills/$name" "$dest" >/dev/null 2>&1; then ok "Skill $name is up to date"; continue; fi
      if [ -e "$dest" ] && ! yn "Replace the skill at $dest with this version?"; then warn "Skill $name left as is"; continue; fi
      rm -rf "$dest"; cp -R "$root/skills/$name" "$dest" && ok "Copied skill $name to $dest"
    else
      if [ -e "$dest" ] && [ ! -L "$dest" ]; then warn "Skill $name not linked: $dest already exists"; continue; fi
      ln -sfn "$root/skills/$name" "$dest" && ok "Skill $name available in every project"
    fi
  done
}

# capture_token: gets a token from claude setup-token without copying. Prints the token, or a reason on stderr and returns 1.
capture_token() {
  local out tok size
  CAPTURE_FILE=$(umask 077; mktemp) || { bad "Could not create a temporary file." >&2; return 1; }
  size=$(stty size </dev/tty 2>/dev/null) || size=""
  if [ -n "$size" ]; then CAPTURE_TTY="rows ${size% *} cols ${size#* }"; stty cols 500 </dev/tty 2>/dev/null || true; fi
  run_setup_token "$CAPTURE_FILE" >&2 || true
  out=$(strip_escapes "$(cat "$CAPTURE_FILE" 2>/dev/null)")
  cleanup_capture
  if [[ $out =~ sk-ant-oat01-[A-Za-z0-9_-]* ]]; then
    tok=${BASH_REMATCH[0]}
    if [ "${#tok}" -ge "$TOKLEN" ]; then printf '%s' "$tok"; return 0; fi
    bad "The sign-in gave only ${#tok} of $TOKLEN characters of the token, so it looks cut off." >&2
  else
    bad "Could not find a token in what the sign-in printed." >&2
  fi
  return 1
}

setup_instabox() {
  local saved code key tries=0
  saved=$(get_saved INSTABOX_API_KEY)
  if [ -n "$saved" ]; then
    spin_start "Checking the saved Instabox key"
    code=$(http_code "$saved")
    spin_stop
    if [ "$code" = 200 ]; then
      STATUS_INSTABOX="OK ($(mask ibk_ "$saved"))"
      ok "Instabox key saved and working" "$(mask ibk_ "$saved")${SPIN_T:+, $SPIN_T}"
      yn "Replace it?" || return 0
    else
      warn "Instabox key saved ($(mask ibk_ "$saved")) but the check failed" "HTTP $code"
    fi
  fi
  while [ "$tries" -lt 3 ]; do
    drain_tty
    ask "Instabox API key" "Create one at $DASH" "It starts with ibk_."
    ask_line "Paste it (nothing shows as you paste${saved:+; Enter keeps the saved key}):"
    read_secret key
    if [ -z "$key" ]; then
      [ -n "$saved" ] || stop_empty
      ok "Kept the saved key"; return 0
    fi
    if ! parse_ibk "$key"; then tries=$((tries + 1)); continue; fi
    key=$PARSED
    spin_start "Checking the key with Instabox"
    code=$(http_code "$key")
    spin_stop
    case $code in
      200) ok "Instabox key works" "$SPIN_T" ;;
      401|403) bad "Instabox rejected this key." "Create a new one at $DASH"; tries=$((tries + 1)); continue ;;
      *) yn "Could not check the key (HTTP $code). Save it anyway?" || { tries=$((tries + 1)); continue; } ;;
    esac
    write_env INSTABOX_API_KEY "$key" || { bad "Could not write $(cfg)." >&2; exit 1; }
    STATUS_INSTABOX="OK ($(mask ibk_ "$key"))"
    ok "Saved the Instabox key" "$(mask ibk_ "$key")"
    INSTABOX_KEY_CHANGED=1
    return
  done
  if [ -n "$saved" ]; then warn "Stopped the Instabox step after 3 tries. Your saved key is unchanged. Run $(rerun_cmd) again to retry."
  else warn "Stopped the Instabox step after 3 tries. Nothing is saved. Run $(rerun_cmd) again to retry."; fi
}

setup_claude() {
  local saved key tries=0 auto=1 acct marker result reason shown
  migrate_key CLAUDE_CODE_OAUTH_TOKEN || true
  migrate_key ANTHROPIC_API_KEY || true
  saved=$(get_saved CLAUDE_CODE_OAUTH_TOKEN)
  marker=$(get_saved CLOUDY_CLOUD_TOKEN_ACCOUNT)
  if [ -n "$saved" ] || is_proxied CLAUDE_CODE_OAUTH_TOKEN; then
    if [ -n "$saved" ]; then shown=$(mask sk-ant-oat01- "$saved"); else shown="stored in Instabox"; fi
    STATUS_CLAUDE="OK ($shown${marker:+, $marker})"
    if [ -n "$marker" ] && [ -n "$LOCAL_ACCOUNT" ] && [ "$marker" != "$LOCAL_ACCOUNT" ]; then
      warn "The saved Claude token is for $marker, but your local Claude is $LOCAL_ACCOUNT."
    else
      ok "Claude token saved" "$shown${marker:+, account $marker}"
    fi
    yn "Replace it?" || return 0
  elif [ -n "$(get_saved ANTHROPIC_API_KEY)" ] || is_proxied ANTHROPIC_API_KEY; then
    warn "Subagents use a saved ANTHROPIC_API_KEY" "billed per use"
    yn "Replace it with a setup-token?" || return 0
  fi
  while [ "$tries" -lt 3 ]; do
    drain_tty
    if [ "$auto" = 1 ]; then
      ask "Claude token for subagents" "Press Enter to sign in now (a browser opens), or paste a token." "Subagents use the account you sign in with. Your own claude login is not changed."
      ask_line "Enter, or paste a token (nothing shows as you paste):"
    else
      ask_line "Paste the token (starts with sk-ant-oat01-; nothing shows as you paste${saved:+; Enter keeps the saved token}):"
    fi
    read_secret key
    if [ -z "$key" ]; then
      if [ "$auto" = 1 ]; then
        auto=0
        hint "Starting claude setup-token; follow the browser sign-in (nothing to copy)."
        if key=$(capture_token); then :; else
          hint "Paste a token instead: in another terminal run claude setup-token, then copy it here."; continue
        fi
      else
        [ -n "$saved" ] || stop_empty
        ok "Kept the saved token"; return 0
      fi
    else
      auto=0
    fi
    if ! parse_claude "$key"; then tries=$((tries + 1)); continue; fi
    key=$PARSED
    [ "${#key}" -eq "$TOKLEN" ] || warn "This token is ${#key} characters; tokens from claude setup-token are usually $TOKLEN" "the check below decides"
    hint "One tiny Claude request; this uses a very small amount of Claude usage."
    spin_start "Checking the token"
    result=$(claude_check "$key"); reason=${result#* }
    spin_stop
    case $result in
      ok) ok "Claude token works" "$SPIN_T" ;;
      fail*) bad "Claude rejected this token: $reason"; hint "Make a fresh one with claude setup-token and try again."; tries=$((tries + 1)); continue ;;
      *) yn "Could not check the token ($reason). Save it anyway?" || { tries=$((tries + 1)); continue; } ;;
    esac
    keep_key CLAUDE_CODE_OAUTH_TOKEN "$key"
    acct=$(claude_account "$key")
    if [ -n "$acct" ]; then write_env CLOUDY_CLOUD_TOKEN_ACCOUNT "$acct"; else del_env CLOUDY_CLOUD_TOKEN_ACCOUNT; fi
    STATUS_CLAUDE="OK ($(mask sk-ant-oat01- "$key")${acct:+, $acct})"
    ok "Saved the Claude token" "$(mask sk-ant-oat01- "$key")"
    hint "Subagents use the Claude account the token was made with${acct:+ ($acct)}."
    return
  done
  if [ -n "$saved" ]; then STATUS_CLAUDE="OK ($(mask sk-ant-oat01- "$saved"), unchanged)"; warn "Stopped the Claude step after 3 tries. Your saved token is unchanged. Run $(rerun_cmd) again to retry."
  else warn "Stopped the Claude step after 3 tries. No token is saved. Run $(rerun_cmd) again to retry."; fi
}

# Cloud coordinators start workers, so their machine needs the Instabox key. Instabox reserves the INSTABOX_ prefix, so the
# coordinator's copy is the secret CLOUDY_CLOUD_INSTABOX_API_KEY (host api.instabox.sh): an extra copy of your key's value.
# Your laptop keeps using the real INSTABOX_API_KEY. The value goes on stdin, never on a command line.
store_coordinator_key() {
  local name=CLOUDY_CLOUD_INSTABOX_API_KEY key
  # A key saved in this run (INSTABOX_KEY_CHANGED) replaces the stored copy, so rotating the key does not leave the old one.
  [ -z "${INSTABOX_KEY_CHANGED:-}" ] && is_proxied "$name" && secret_visible "$name" && return 0
  key=$(get_saved INSTABOX_API_KEY)
  if [ -n "$key" ] && store_secret "$name" "$key"; then ok "Stored $name as an Instabox secret" "coordinators see a placeholder"
  else warn "Could not store $name, so coordinator start will refuse to run" "run $(rerun_cmd) --more again to retry"; return 1; fi
}

# have_tty: true when setup can show a question and read the answer (tests replace it).
have_tty() { [ -t 0 ] && [ -t 1 ]; }

# Optional (setup --more): cloud coordinators. "coordinator image" handles the sign-in, retry, saving and progress itself,
# so it runs with the terminal attached and nothing captured. It writes CLOUDY_CLOUD_SNAPSHOT_ACCOUNT when it saves.
setup_coordinators() {
  local root=$1 snap marker acct
  snap=$(get_saved CLOUDY_CLOUD_COORDINATOR_SNAPSHOT)
  marker=$(get_saved CLOUDY_CLOUD_SNAPSHOT_ACCOUNT)
  if ! have_tty; then hint "Set up coordinators later on a terminal: $(rerun_cmd) --more"; return 0; fi
  if [ -n "$snap" ]; then
    STATUS_COORD="ready${marker:+ ($marker)}"
    if [ -n "$marker" ] && [ -n "$LOCAL_ACCOUNT" ] && [ "$marker" != "$LOCAL_ACCOUNT" ]; then
      warn "Coordinators use $marker, but your local Claude is $LOCAL_ACCOUNT."
    fi
    yn "Cloud coordinators use the Claude account saved in their image${marker:+ ($marker)}. Sign in again to use a different account?" || return 0
  else
    yn "Set up cloud coordinators now? It signs you in to Claude once and saves an image; this takes 10 to 20 minutes." || { STATUS_COORD=declined; return 0; }
  fi
  # Ready only when the saved image changed: a command that exits 0 without saving one (no terminal) is not a success.
  if "$root/bin/cloudy-cloud" coordinator image && [ -n "$(get_saved CLOUDY_CLOUD_COORDINATOR_SNAPSHOT)" ] && [ "$(get_saved CLOUDY_CLOUD_COORDINATOR_SNAPSHOT)" != "$snap" ]; then
    acct=$(get_saved CLOUDY_CLOUD_SNAPSHOT_ACCOUNT)
    STATUS_COORD="ready${acct:+ ($acct)}"
  else
    bad "Coordinator setup did not finish. Run $(rerun_cmd) --more again to retry." >&2
    STATUS_COORD="failed (run $(rerun_cmd) --more again)"
  fi
}

# Cloud coordinators are for Instabox only. They work from a clone or an npm install alike.
offer_coordinators() { [ "$PROVIDER" = self-hosted ] || setup_coordinators "$1"; }

# Prints the JSON list of the org's secrets (nothing if the org lookup fails).
secrets_list() { # optional $1: the key to use (default: the saved one)
  local key orgs id
  key=${1:-$(get_saved INSTABOX_API_KEY)}
  orgs=$(api_get "$key" /v1/orgs) || true
  id=$(printf '%s' "$orgs" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);
    const a=Array.isArray(j)?j:(j.items||j.data||j.orgs||[]);const o=a.find(x=>x&&x.personal)||a[0];console.log(o&&o.id||"")}catch{console.log("")}})') || true
  [[ $id =~ ^[A-Za-z0-9_.-]+$ ]] || return 0
  api_get "$key" "/v1/orgs/$id/secrets" || true
}

# Prints yes, no, or unknown (the org lookup failed or has an unexpected shape).
gh_secret_state() { # optional $1: the Instabox key
  secrets_list "${1:-}" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);
    const a=Array.isArray(j)?j:(j.items||j.data||j.secrets||[]);
    console.log(a.some(x=>x.name==="GH_TOKEN"&&["github.com","api.github.com"].every(h=>(x.hosts||[]).includes(h)))?"yes":"no")}catch{console.log("unknown")}})'
}

# alerts_state KEY: prints one line "STATE ORG PERCENT PCTSET OVERAGE CAP" about the usage alert emails of the key's org (GET /v1/me, then GET /v1/orgs/ID).
# STATE is on, off (the percent is 0 or the overage email is off), none (no paid-plan fields: the free tier) or unknown (a request failed or did not parse).
# OVERAGE is on or off. CAP is the spend cap in dollars, or none. Nothing is written.
alerts_state() {
  local me id body
  me=$(api_get "$1" /v1/me) || true
  id=$(printf '%s' "$me" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).org||{}).id||"")}catch{console.log("")}})') || true
  [[ $id =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] || { echo "unknown - 0 no off none"; return 0; }
  body=$(api_get "$1" "/v1/orgs/$id") || true
  printf '%s' "$body" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const id=process.argv[1];try{const l=JSON.parse(s).limits;
    if(!l||typeof l!=="object")throw 0;
    const cap=typeof l.spendCapUSD==="number"?String(l.spendCapUSD):"none";
    if(typeof l.usageAlertPercent!=="number")return console.log("none "+id+" 0 no off "+cap);
    const p=l.usageAlertPercent,o=l.overageAlert===true;
    console.log((p>0&&o?"on":"off")+" "+id+" "+p+" "+(p>0?"yes":"no")+" "+(o?"on":"off")+" "+cap)}catch{console.log("unknown "+id+" 0 no off none")}})' -- "$id"
}

# alerts_report STATE ORG PERCENT OVERAGE CAP: prints the line for a state that needs no question (on, none, unknown) and returns 0; returns 1 for off.
alerts_report() {
  local cap=none
  [ "$5" = none ] || cap="\$$5"
  case $1 in
    on) ok "Instabox emails you at $3% of included usage and beyond it"
        hint "(pay as you go; spend cap: $cap)"
        hint "Instabox can stop machines at a monthly spend cap. Set one:"
        hint "npx --yes instabox@latest workspace spend-cap $2 <usd>" ;;
    none) hint "Usage alert emails apply to paid Instabox plans only." ;;
    unknown) warn "Could not read your Instabox usage alerts"
        hint "check with: npx --yes instabox@latest workspace alerts ${2:-<org-id>}" ;;
    *) return 1 ;;
  esac
}

ALERTS_FIX='npx --yes instabox@latest workspace alerts ORG --usage 80 --overage on'

# Shows the Instabox usage alert emails and, when one is off, asks once whether to turn them on through your instabox login.
setup_alerts() {
  local st org pct pset ov cap flags=() fix
  spin_start "Reading your Instabox usage alerts"
  read -r st org pct pset ov cap <<<"$(alerts_state "$(get_saved INSTABOX_API_KEY)")"
  spin_stop
  alerts_report "$st" "$org" "$pct" "$ov" "$cap" && return 0
  fix=${ALERTS_FIX/ORG/$org}
  ask "Instabox usage alert emails" \
    "Instabox can email the workspace's owner and admins at 80% of what the month includes," \
    "and again when usage goes beyond it (pay as you go). Yours: usage alert $([ "$pset" = yes ] && echo "$pct%" || echo off), overage alert $ov, spend cap $([ "$cap" = none ] && echo none || echo "\$$cap")." \
    "Saying yes changes your Instabox account through your instabox login."
  yn_strict "Turn them on now?" || { hint "Left as they are. Change them any time: $fix"; return 0; }
  [ "$pset" = yes ] || flags+=(--usage 80)
  [ "$ov" = on ] || flags+=(--overage on)
  if ibx_npx whoami >/dev/null 2>&1 || ibx_npx login </dev/tty; then
    ibx_npx workspace alerts "$org" "${flags[@]}" </dev/tty || true
  fi
  spin_start "Confirming"
  read -r st org pct pset ov cap <<<"$(alerts_state "$(get_saved INSTABOX_API_KEY)")"
  spin_stop
  if [ "$st" = on ]; then ok "Instabox will email you at $pct% of included usage and when usage goes beyond it"
  else warn "Could not change the alerts (your login may not be the workspace's owner or admin, or may point at another account)" "check with npx instabox@latest whoami, or set them at https://instabox.sh Billing, or: $fix"; fi
}

setup_github() {
  local state
  spin_start "Looking for GH_TOKEN in Instabox"
  state=$(gh_secret_state)
  spin_stop
  if [ "$state" = unknown ]; then
    warn "Could not confirm GH_TOKEN (could not read your Instabox orgs)" "check with: npx --yes instabox@latest secrets ls"
    GH_RESULT="not confirmed"; return
  fi
  if [ "$state" = yes ]; then
    GH_RESULT="OK (GH_TOKEN stored in Instabox)"
    ok "GitHub token stored in Instabox" "as GH_TOKEN"
    yn "Replace it?" || return 0
  fi
  ask "GitHub token" "Subagents push their branches with it. Instabox stores it;" "subagent machines only see a placeholder." \
    "Create a fine-grained token at https://github.com/settings/personal-access-tokens/new" \
    "Repository access: only the repos you will use with cloudy-cloud." "Permissions: Contents, Pull requests and Workflows read and write; Actions read." \
    "(Workflows lets a subagent push .github/workflows; Actions lets it see CI.)" \
    "Next, the Instabox CLI signs you in (if needed) and asks for the token." "Nothing shows as you paste."
  # The token goes from the terminal straight to the Instabox CLI; this script never sees it.
  ibx_npx whoami >/dev/null 2>&1 || ibx_npx login </dev/tty
  ibx_npx secrets set GH_TOKEN --host github.com --host api.github.com </dev/tty
  spin_start "Confirming GH_TOKEN"
  state=$(gh_secret_state)
  spin_stop
  if [ "$state" = no ]; then
    bad "GH_TOKEN is not visible to your Instabox API key." >&2
    hint "The Instabox CLI may be signed in to a different account or workspace: check with npx instabox@latest whoami, then run $(rerun_cmd) again." >&2
    exit 1
  fi
  if [ "$state" = yes ]; then GH_RESULT="OK (GH_TOKEN stored in Instabox)"; ok "GH_TOKEN is stored"
  else GH_RESULT="not confirmed"; warn "Could not confirm GH_TOKEN (could not read your Instabox orgs)" "check with: npx --yes instabox@latest secrets ls"; fi
}

# Optional: a provider key for open-model workers (profiles glm, deepseek, particle, openrouter).
setup_provider() { # setup_provider NAME LABEL WHERE [WORKERS [EXTRA HINT]]
  local name=$1 label=$2 where=$3 workers=${4:-open-model workers} saved key
  migrate_key "$name" || true
  saved=$(get_saved "$name")
  if [ -n "$saved" ] || is_proxied "$name"; then
    if [ -n "$saved" ]; then ok "$label key saved" "$(mask "" "$saved")"; else ok "$label key stored in Instabox" "as $name"; fi
    yn "Replace it?" || return 0
  fi
  drain_tty
  ask "$label key for $workers (optional)" "Get one at $where" ${5:+"$5"}
  ask_line "Paste it (nothing shows as you paste; Enter to skip):"
  read_secret key
  [ -n "$key" ] || { hint "Skipped $label."; return 0; }
  keep_key "$name" "$key"
  ok "Saved the $label key" "$(mask "" "$key")"
  if is_proxied "$name"; then hint "Stored as an Instabox secret: worker machines see a placeholder, not the key."
  elif [ "${PROVIDER:-}" = instabox ]; then hint "Not stored as a secret: workers that need this key are refused until you store it (run $(rerun_cmd) --more again)."
  else hint "Unlike GH_TOKEN, this key is stored on the worker machines that use it."; fi
}

# summary_row LABEL STATUS: a green check for OK and ready, a yellow triangle for anything else.
summary_row() {
  local v=$2
  case $v in
    OK\ \(*\)) [ "$UI" != 1 ] || { v=${v#OK \(}; v=${v%\)}; }; box_row "$C_OK" "$M_OK" "$1" "$v" ;;
    ready*) box_row "$C_OK" "$M_OK" "$1" "$v" ;;
    *) box_row "$C_WARN" "$M_WARN" "$1" "$v" ;;
  esac
}

# choose_provider [NAME [DEFAULT]]: sets PROVIDER to instabox or self-hosted, asking unless NAME is given. Enter means DEFAULT (instabox).
# Nothing is saved here; a changed provider is written once its own step has what it needs.
choose_provider() {
  local a def=${2:-instabox} d1="" d2=""
  case ${1:-} in
    instabox|self-hosted) PROVIDER=$1; return 0 ;;
    "") ;;
    *) bad "Unknown provider \"$1\"" "use --provider instabox or --provider self-hosted" >&2; exit 1 ;;
  esac
  if [ "$def" = self-hosted ]; then d2=" (saved, Enter keeps it)"; else d1=" (default)"; fi
  drain_tty
  ask "Where should subagents run?" "1  Instabox cloud$d1" "2  your own machine over SSH (a Mac or Linux box you control)$d2"
  ask_line "Type 1 or 2 (Enter for $([ "$def" = self-hosted ] && echo 2 || echo 1)):"
  IFS= read -r a </dev/tty || a=""
  case $a in 1) PROVIDER=instabox ;; 2) PROVIDER=self-hosted ;; *) PROVIDER=$def ;; esac
}

# choose_agents: sets AGENTS without asking when it can: the saved choice, else claude if found, else the agents found on PATH.
# It asks only when none is found, or in setup --more (MORE=1), where Enter keeps the current list (claude when none is saved).
choose_agents() {
  local a c det="" input tries=0 unknown parts list saved def
  for a in claude codex opencode pi free-pi; do
    c=$a; [ "$a" != free-pi ] || c=free-pi-cli
    ! command -v "$c" >/dev/null || det="${det:+$det,}$a"
  done
  saved=$(get_saved CLOUDY_CLOUD_AGENTS)
  # Claude is the default agent and needs nothing saved, so finding claude means claude; other agents are saved when they are all that is found.
  AGENTS=${saved:-$det}
  [ -n "$saved" ] || ! agents_has claude || AGENTS=claude
  if [ -z "$AGENTS" ] || [ "${MORE:-0}" = 1 ]; then
    def=${AGENTS:-claude}; AGENTS=""
    while [ "$tries" -lt 3 ]; do
      drain_tty
      ask "Which agents do you run locally?" "Choose from: claude, codex, opencode, pi, free-pi (several, separated by spaces)." "${saved:+Saved: $saved. }Found on this computer: ${det:-none}. Only what these agents need is asked for."
      ask_line "Enter for $def, or type your choice:"
      IFS= read -r input </dev/tty || input=""
      input=${input//,/ }
      [ -n "${input//[[:space:]]/}" ] || input=${def//,/ }
      read -ra parts <<<"$input"
      unknown=""; list=""
      for a in "${parts[@]}"; do
        case $a in
          claude|codex|opencode|pi|free-pi) case ",$list," in *",$a,"*) ;; *) list="${list:+$list,}$a" ;; esac ;;
          *) unknown=$a ;;
        esac
      done
      if [ -n "$unknown" ]; then bad "Unknown agent \"$unknown\"" "choose from claude, codex, opencode, pi, free-pi"; tries=$((tries + 1)); continue; fi
      AGENTS=$list; break
    done
    [ -n "$AGENTS" ] || stop_empty
    if ! agents_has claude && yn "Also run Claude Code workers in the cloud? (needs a Claude token)"; then AGENTS="$AGENTS,claude"; fi
  fi
  # Claude alone is the default when nothing is saved, so an existing Claude user's config stays as it was.
  if [ "$AGENTS" != "$saved" ] && { [ "$AGENTS" != claude ] || [ -n "$saved" ]; }; then
    write_env CLOUDY_CLOUD_AGENTS "$AGENTS" || { bad "Could not write $(cfg)." >&2; exit 1; }
  fi
  ok "Agents: $AGENTS"
  if agents_has claude && ! command -v claude >/dev/null; then
    bad "Claude Code is missing" "Install it: https://code.claude.com, or run $(rerun_cmd) --more and remove claude from your agents"; exit 1
  fi
}

# setup_self_hosted ROOT: the self-hosted questions live in src/self-hosted-setup.mjs.
setup_self_hosted() {
  if node "$1/src/self-hosted-setup.mjs" setup; then STATUS_SH="OK ($(get_saved CLOUDY_CLOUD_SSH_HOST), $(get_saved CLOUDY_CLOUD_SELF_HOSTED_SLOTS) at once)"
  else bad "Self-hosted setup did not finish. Run $(rerun_cmd) again." >&2; exit 1; fi
}

# worker_usable: some credential can start a first worker on this provider (Instabox needs a proxy secret; a self-hosted box takes a saved value).
worker_usable() {
  local n
  # With claude among the agents, the Claude step above already handled the Claude credential (saved, or declined by you).
  if agents_has claude; then
    for n in CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY; do { [ -n "$(get_saved $n)" ] || is_proxied $n; } && return 0; done
  fi
  for n in CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY OPENAI_API_KEY PARTICLE_API_KEY OPENROUTER_API_KEY; do
    is_proxied $n && return 0
    [ "$PROVIDER" != self-hosted ] || [ -z "$(get_saved $n)" ] || return 0
  done
  [ -f "$(codex_auth_file)" ]
}

# incomplete WHAT: records a step that did not finish. Setup then ends with "Setup incomplete" and exit status 1.
incomplete() { INCOMPLETE="${INCOMPLETE:+$INCOMPLETE; }$1"; }
# next_setup_cmd: the rerun command an incomplete setup prints; --more only when a reason needs it (today: the coordinator image).
next_setup_cmd() {
  local c; c=$(rerun_cmd)
  case $INCOMPLETE in *"coordinator image"*) c="$c --more" ;; esac
  [ "${PROVIDER:-}" = self-hosted ] && c="$c --provider self-hosted"
  printf '%s' "$c"
}

# ask_worker_keys: the keys an agent needs (OpenAI for codex; Particle.ai and OpenRouter for the others).
ask_worker_keys() {
  ! agents_has codex || setup_provider OPENAI_API_KEY OpenAI https://platform.openai.com/api-keys "Codex workers" "Or use your ChatGPT login instead: codex login, then: install -m 600 ~/.codex/auth.json ~/.config/cloudy-cloud/codex-auth.json"
  setup_provider PARTICLE_API_KEY Particle.ai https://platform.particle.ai
  setup_provider OPENROUTER_API_KEY OpenRouter https://openrouter.ai/keys
}

usage() { echo "usage: install.sh [--more] [--provider instabox|self-hosted|microsandbox] [--check-only]" >&2; }

main() {
  local provider_arg="" host acct more=0 check_only=0 saved_provider tools_out root
  while [ $# -gt 0 ]; do
    case $1 in
      --provider) [ $# -ge 2 ] || { usage; exit 2; }; provider_arg=$2; shift 2 ;;
      --more) more=1; shift ;;
      --check-only) check_only=1; shift ;;
      *) usage; exit 2 ;;
    esac
  done
  case $provider_arg in ""|instabox|self-hosted|microsandbox) ;; *) bad "Unknown provider \"$provider_arg\"" "use --provider instabox, self-hosted or microsandbox" >&2; exit 2 ;; esac
  MORE=$more
  [ -z "$provider_arg" ] || export CLOUDY_CLOUD_PROVIDER=$provider_arg # --check-only checks the provider you name
  root=$(cd "$(dirname "$0")" && pwd)
  # The saved provider is read only after the legacy-name migration (which --check-only skips: it changes nothing).
  [ "$check_only" = 1 ] || { . "$root/bin/migrate-config.sh"; migrate_config; }
  saved_provider=$(get_saved CLOUDY_CLOUD_PROVIDER)
  # microsandbox keeps every credential on this computer in the env file, so setup has nothing to ask or save.
  # --provider beats an exported CLOUDY_CLOUD_PROVIDER, which beats the saved line.
  if [ "$check_only" = 0 ] && [ "${provider_arg:-${CLOUDY_CLOUD_PROVIDER:-$saved_provider}}" = microsandbox ]; then
    ok "The provider is microsandbox" "setup does not configure it"
    hint "Keys stay on this computer in the env file:"
    hint "$(cfg)"
    hint "See \"Run on this computer with microsandbox\" in the README."
    hint "Check that setup: $(rerun_cmd) --check-only"
    exit 0
  fi
  if [ "$check_only" = 0 ] && [ ! -t 0 ]; then
    case $0 in */node_modules/*) echo "Setup asks for keys, so run it in a terminal: cloudy-cloud setup" ;;
      *) echo "install.sh asks for keys, so run it in a terminal: ./install.sh" ;; esac; exit 1
  fi
  trap 'cleanup_capture; ui_cleanup; stty echo 2>/dev/null' EXIT
  trap 'exit 130' INT TERM
  [ "$check_only" = 1 ] || banner
  if [ "$check_only" = 1 ]; then
    AGENTS=$(eff CLOUDY_CLOUD_AGENTS); [ -n "$AGENTS" ] || AGENTS=claude
    tools_out=$(check_prereqs) || PREREQ_FAIL=1
    [ -z "$tools_out" ] || { step 1 Tools; printf '%s\n' "$tools_out"; }
    check_setup; exit $?
  fi
  step 1 Tools
  check_prereqs || exit 1
  ok "git, node, npm and curl are installed"

  local branch sha log
  log=$(mktemp)
  if from_npm "$root"; then
    ok "Dependencies came with the npm package"
  else
    spin_start "Installing dependencies"
    (cd "$root" && npm install --silent --no-audit --no-fund) >"$log" 2>&1 || { spin_stop; cat "$log" >&2; rm -f "$log"; bad "npm install failed." >&2; exit 1; }
    spin_stop
    ok "Dependencies installed" "$SPIN_T"
  fi
  rm -f "$log"
  link_command "$root"
  link_skill "$root"

  # Instabox is the default; the question appears only when a self-hosted choice is saved and no --provider is given. Enter keeps the saved one.
  if [ -z "$provider_arg" ] && [ "$saved_provider" != self-hosted ]; then provider_arg=instabox; fi
  choose_provider "$provider_arg" "$saved_provider"
  choose_agents
  if agents_has claude; then
    LOCAL_ACCOUNT=$(claude_account)
    [ -z "$LOCAL_ACCOUNT" ] || ok "Your local Claude" "$LOCAL_ACCOUNT"
    warn_shell_env CLAUDE_CODE_OAUTH_TOKEN
  fi
  warn_shell_env INSTABOX_API_KEY
  if [ "$PROVIDER" = self-hosted ]; then
    step 2 "Your own machine"
    setup_self_hosted "$root"
  else
    step 2 "Instabox key"
    setup_instabox
    [ -n "$(get_saved INSTABOX_API_KEY)" ] || { bad "No Instabox key is saved, so setup cannot continue. Run $(rerun_cmd) again."; exit 1; }
    # save the switch only when setup moved off a provider that was saved (a fresh install leaves the line out)
    [ -z "$saved_provider" ] || [ "$saved_provider" = instabox ] || write_env CLOUDY_CLOUD_PROVIDER instabox
  fi
  if agents_has claude; then
    step 3 "Claude token"; setup_claude
    case $STATUS_CLAUDE in OK*) ;; *) incomplete "no Claude token is saved" ;; esac
  else step 3 "Worker keys"; hint "No Claude token is needed for $AGENTS."; fi
  if [ "$PROVIDER" = self-hosted ]; then step 4 "Optional keys"; else step 4 "GitHub token"; setup_github; fi
  STATUS_GH=${GH_RESULT:-"not confirmed"}
  [ "$PROVIDER" = self-hosted ] || case $STATUS_GH in OK*) ;; *) incomplete "the GitHub token is not confirmed" ;; esac
  if [ "$more" = 1 ]; then
    [ "$PROVIDER" = self-hosted ] || setup_alerts
    # The OpenAI key is offered when codex is chosen or installed, even if claude was chosen too.
    if ! agents_has codex && command -v codex >/dev/null; then
      setup_provider OPENAI_API_KEY OpenAI https://platform.openai.com/api-keys "Codex workers" "Or use your ChatGPT login instead: codex login, then: install -m 600 ~/.codex/auth.json ~/.config/cloudy-cloud/codex-auth.json"
    fi
    ask_worker_keys
    if [ "$PROVIDER" != self-hosted ]; then
      store_coordinator_key || true # the coordinator copy of your Instabox key; nested coordinators need it even if you build no image now
      offer_coordinators "$root"
    fi
    case $STATUS_COORD in failed*) incomplete "the coordinator image was not saved" ;; esac
  elif ! worker_usable; then
    # A first worker needs some credential. Ask for the keys the chosen agents use.
    hint "No worker credential is saved yet, so a first worker cannot start."
    ask_worker_keys
  fi
  worker_usable || incomplete "no worker credential (a Claude token or a provider key)"
  # A saved image counts as ready on a plain run too.
  if [ "$STATUS_COORD" = "not set up" ] && [ -n "$(get_saved CLOUDY_CLOUD_COORDINATOR_SNAPSHOT)" ]; then
    acct=$(get_saved CLOUDY_CLOUD_SNAPSHOT_ACCOUNT); STATUS_COORD="ready${acct:+ ($acct)}"
  fi

  branch=$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null)
  sha=$(git -C "$root" rev-parse --short HEAD 2>/dev/null)
  box_open Summary
  if [ "$PROVIDER" = self-hosted ]; then
    summary_row "Your machine" "$STATUS_SH"
    ! agents_has claude || summary_row "Claude token" "$STATUS_CLAUDE"
  else
    summary_row "Instabox key" "$STATUS_INSTABOX"
    ! agents_has claude || summary_row "Claude token" "$STATUS_CLAUDE"
    summary_row "GitHub token" "$STATUS_GH"
    [ "$more" = 0 ] && [ "$STATUS_COORD" = "not set up" ] || summary_row "Coordinators" "$STATUS_COORD"
  fi
  box_close
  echo
  if from_npm "$root"; then
    hint "To update, run: npm install -g cloudycloud@latest"
  else
    hint "cloudy-cloud runs from $root"
    hint "It is on branch $branch at $sha."
    hint "To update, run this in that folder: git pull && npm install"
  fi
  local prov=""; [ "$PROVIDER" = self-hosted ] && prov=" --provider self-hosted"
  hint "To change a key later, run: $(rerun_cmd)$prov"
  hint "Restart any open cloudy-cloud session to use the new keys."
  if [ -n "$INCOMPLETE" ]; then
    echo
    printf '  %s\n' "Setup incomplete:"
    local IFS=';' r
    for r in $INCOMPLETE; do printf '    - %s\n' "${r# }"; done
    printf '  %s\n' "Next: $(next_setup_cmd)"
    exit 1
  fi
  box_open Next
  box_text "In a repo with a github.com origin, run:"
  host=${AGENTS%%,*}; [ "$host" != claude ] || host=""
  box_text "  cloudy-cloud${host:+ $host}" "$C_B$C_ACC"
  box_text "then type:"
  box_text "  use a subagent to run hostname, write it to proof.txt," "$C_ACC"
  box_text "  commit and push, and tell me the result" "$C_ACC"
  box_close
  hint "Recommended: block direct pushes to your main branch. In a repo, run: cloudy-cloud protect"
  echo
  printf '  %s\n' "Setup complete."
  if [ "$PROVIDER" = self-hosted ]; then
    printf '  %s\n' "Other model keys: $(rerun_cmd) --more --provider self-hosted."
  else
    case $STATUS_COORD in ready*|declined) ;; *) coordinators_offered && printf '  %s\n' "Coordinators: $(rerun_cmd) --more." ;; esac
    printf '  %s\n' "Usage alerts and other model keys: $(rerun_cmd) --more."
  fi
}

[ "${BASH_SOURCE[0]}" = "$0" ] && main "$@"
