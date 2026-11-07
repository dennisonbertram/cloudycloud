#!/usr/bin/env bash
# Sets up claude-cloud: checks tools, links the command, and asks for each key.
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
    printf '  %s%s  %s%s%s  %s%s of 4%s\n' "$bar" "$C_X" "$C_B" "$2" "$C_X" "$C_DIM" "$1" "$C_X"
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

# The logo. logo_frame EDGE draws it three lines tall, revealed from the left up to column EDGE with a cloud in front.
LOGO=('╔═╗╦  ╔═╗╦ ╦╔╦╗╔═╗   ╔═╗╦  ╔═╗╦ ╦╔╦╗'
      '║  ║  ╠═╣║ ║ ║║║╣ ───║  ║  ║ ║║ ║ ║║'
      '╚═╝╩═╝╩ ╩╚═╝═╩╝╚═╝   ╚═╝╩═╝╚═╝╚═╝═╩╝')
logo_frame() {
  local r i lo seg line code
  local shades=(33 33 39 39 45 45 81 81 87 87 123 123)
  for r in 0 1 2; do
    line="  "
    for i in 0 1 2 3 4 5 6 7 8 9 10 11; do
      lo=$((i * 3)); seg=${LOGO[r]:$lo:3}
      if [ "$((lo + 3))" -le "$1" ]; then
        code=$C_ACC; [ "$WIDE" = 0 ] || code=$'\e[38;5;'"${shades[i]}m"
        line="$line$code$seg"
      elif [ "$lo" -lt "$((${1} + 6))" ]; then line="$line${C_DIM}░░░"
      else line="$line   "; fi
    done
    printf '%s%s\n' "$line" "$C_X"
  done
}

DESCRIPTION="Checks your tools, links the command and saves your keys."
# banner: the animated logo on a real terminal; a one-line title otherwise. Any key skips the animation.
banner() {
  if [ "$UI" != 1 ]; then printf 'claude-cloud setup\n%s\n' "$DESCRIPTION"; return; fi
  if [ "$UTF" != 1 ] || [ "$COLS" -lt 60 ]; then
    printf '\n  %s%s%s %sclaude-cloud%s  setup\n  %s%s%s\n' "$C_ACC" "$([ "$UTF" = 1 ] && echo ◆ || echo '*')" "$C_X" "$C_B" "$C_X" "$C_DIM" "$DESCRIPTION" "$C_X"
    return
  fi
  echo
  if [ -n "${CI:-}" ] || [ "${CLAUDE_CLOUD_NO_ANIMATION:-}" = 1 ] || ! { : </dev/tty; } 2>/dev/null; then
    logo_frame 99
  else
    local s n
    INTRO_TTY=$(stty -g </dev/tty 2>/dev/null) || INTRO_TTY=""
    stty -echo -icanon min 0 time 1 </dev/tty 2>/dev/null
    printf '\e[?25l'; HIDDEN=1
    for s in 0 1 2 3 4 5 6 7 8 9 10 11 12 13; do
      [ "$s" = 0 ] || printf '\e[3A'
      logo_frame $((s * 3))
      # Waits up to 0.1 s for a key: that is both the frame delay and the skip check.
      n=$(dd bs=1 count=1 </dev/tty 2>/dev/null | wc -c)
      if [ "$((n))" -gt 0 ]; then printf '\e[3A'; logo_frame 99; break; fi
    done
    drain_tty # while echo is still off and input is unbuffered, so a leftover key is neither shown nor kept
    [ -z "$INTRO_TTY" ] || stty "$INTRO_TTY" </dev/tty 2>/dev/null
    INTRO_TTY=""
    printf '\e[?25h'; HIDDEN=0
  fi
  printf '  %s%s%s\n' "$C_DIM" "$DESCRIPTION" "$C_X"
}

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
  printf '  %s?%s %s%s%s %s[y/N]%s ' "$C_ACC" "$C_X" "$C_B" "$1" "$C_X" "$C_DIM" "$C_X" >&2
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

stop_empty() { warn "Stopped. Run $(rerun_cmd) again to continue." >&2; exit 1; }

check_prereqs() {
  local nope=0 v major
  command -v git >/dev/null || { bad "git is missing" "Install it: https://git-scm.com/downloads"; nope=1; }
  v=none
  command -v node >/dev/null && v=$(node -v 2>/dev/null)
  major=${v#v}; major=${major%%.*}
  if ! [[ $major =~ ^[0-9]+$ ]] || [ "$major" -lt 20 ]; then
    bad "Node.js 20 or later is needed (found $v)" "Install it: https://nodejs.org"; nope=1
  fi
  command -v npm >/dev/null || { bad "npm is missing"; nope=1; }
  command -v curl >/dev/null || { bad "curl is missing"; nope=1; }
  command -v claude >/dev/null || { bad "Claude Code is missing" "Install it: https://code.claude.com"; nope=1; }
  return $nope
}

warn_shell_env() {
  [ -z "${!1:-}" ] || warn "$1 is also set in your shell" "claude-cloud uses the shell value, not the saved one"
}

link_command() { # link_command ROOT
  local root=$1 cur other
  cur=$(command -v claude-cloud) || cur=""
  if [ -z "$cur" ]; then
    (cd "$root" && npm link >/dev/null) || { bad "npm link failed" >&2; exit 1; }
    ok "Linked the claude-cloud command"
    command -v claude-cloud >/dev/null ||
      warn "Add this to your shell profile" "export PATH=\"$(npm prefix -g)/bin:\$PATH\""
    return
  fi
  other=$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$cur")
  if [ "$other" = "$root/bin/claude-cloud" ]; then
    ok "claude-cloud already runs from this folder"
  else
    other=${other%/bin/claude-cloud}
    if yn "claude-cloud on your PATH runs from $other. Point it at this folder instead?"; then
      (cd "$root" && npm link >/dev/null) || { bad "npm link failed" >&2; exit 1; }
      ok "Linked the claude-cloud command to this folder"
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

# Links the fleet skill for every project, so any Claude session knows how to run fleets. Leaves a real folder alone.
link_skill() {
  local dest="$HOME/.claude/skills/cloud-fleet"
  mkdir -p "$HOME/.claude/skills" || return 0
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then warn "Fleet skill not linked: $dest already exists"; return 0; fi
  ln -sfn "$1/skills/cloud-fleet" "$dest" && ok "Fleet skill available in every project"
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
    return
  done
  if [ -n "$saved" ]; then warn "Stopped the Instabox step after 3 tries. Your saved key is unchanged. Run $(rerun_cmd) again to retry."
  else warn "Stopped the Instabox step after 3 tries. Nothing is saved. Run $(rerun_cmd) again to retry."; fi
}

setup_claude() {
  local saved key tries=0 auto=1 acct marker result reason
  saved=$(get_saved CLAUDE_CODE_OAUTH_TOKEN)
  marker=$(get_saved CLAUDE_CLOUD_TOKEN_ACCOUNT)
  if [ -n "$saved" ]; then
    STATUS_CLAUDE="OK ($(mask sk-ant-oat01- "$saved")${marker:+, $marker})"
    if [ -n "$marker" ] && [ -n "$LOCAL_ACCOUNT" ] && [ "$marker" != "$LOCAL_ACCOUNT" ]; then
      warn "The saved Claude token is for $marker, but your local Claude is $LOCAL_ACCOUNT."
    else
      ok "Claude token saved" "$(mask sk-ant-oat01- "$saved")${marker:+, account $marker}"
    fi
    yn "Replace it?" || return 0
  elif [ -n "$(get_saved ANTHROPIC_API_KEY)" ]; then
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
    write_env CLAUDE_CODE_OAUTH_TOKEN "$key" || { bad "Could not write $(cfg)." >&2; exit 1; }
    acct=$(claude_account "$key")
    if [ -n "$acct" ]; then write_env CLAUDE_CLOUD_TOKEN_ACCOUNT "$acct"; else del_env CLAUDE_CLOUD_TOKEN_ACCOUNT; fi
    STATUS_CLAUDE="OK ($(mask sk-ant-oat01- "$key")${acct:+, $acct})"
    ok "Saved the Claude token" "$(mask sk-ant-oat01- "$key")"
    hint "Subagents use the Claude account the token was made with${acct:+ ($acct)}."
    return
  done
  if [ -n "$saved" ]; then warn "Stopped the Claude step after 3 tries. Your saved token is unchanged. Run $(rerun_cmd) again to retry."
  else warn "Stopped the Claude step after 3 tries. No token is saved. Run $(rerun_cmd) again to retry."; fi
}

# Removes the image machine so nothing keeps running, or says how to.
coordinator_cleanup() {
  if npx --yes instabox@latest rm --yes "$1" </dev/null >/dev/null 2>&1; then
    ok "Removed the image machine $1" >&2
  else
    warn "The image machine $1 may still be running" "remove it with: npx instabox@latest rm $1 (it also deletes itself after a while)" >&2
  fi
}

# Optional: cloud coordinators. Builds the image machine, opens the Claude sign-in on it, and saves the snapshot.
setup_coordinators() {
  local root=$1 snap marker out name rc=0 acct saveout
  snap=$(get_saved CLAUDE_CLOUD_COORDINATOR_SNAPSHOT)
  marker=$(get_saved CLAUDE_CLOUD_SNAPSHOT_ACCOUNT)
  if [ -n "$snap" ]; then
    STATUS_COORD="ready${marker:+ ($marker)}"
    if [ -n "$marker" ] && [ -n "$LOCAL_ACCOUNT" ] && [ "$marker" != "$LOCAL_ACCOUNT" ]; then
      warn "Coordinators use $marker, but your local Claude is $LOCAL_ACCOUNT."
    fi
    yn "Cloud coordinators use the Claude account saved in their image${marker:+ ($marker)}. Sign in again to use a different account?" || return 0
  else
    yn "Set up cloud coordinators (they keep working when your laptop is closed)?" || return 0
  fi
  hint "This can take a few minutes."
  spin_start "Building the coordinator image machine"
  out=$("$root/bin/claude-cloud" coordinator image 2>&1) || rc=$?
  spin_stop
  name=$(printf '%s\n' "$out" | sed -n 's/^Image machine \([^ ]*\) is ready.*/\1/p; s/.*already exists (\([^)]*\)).*/\1/p' | head -n 1)
  if [ -z "$name" ]; then
    printf '%s\n' "$out" | tail -n 5 >&2
    bad "Could not create the image machine. Run $(rerun_cmd) again to retry." >&2
    STATUS_COORD="failed (run $(rerun_cmd) again)"; return 0
  fi
  ok "Image machine $name is ready" "$SPIN_T"
  hint "Opening the Claude sign-in on it; use the account coordinators should use."
  if ! npx --yes instabox@latest ssh "$name" -- -t claude auth login; then
    bad "The sign-in on the image machine did not finish." >&2
    coordinator_cleanup "$name"
    STATUS_COORD="failed (run $(rerun_cmd) again)"; return 0
  fi
  spin_start "Reading the signed-in account"
  acct=$(npx --yes instabox@latest ssh "$name" -- claude auth status </dev/null 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s.slice(s.indexOf("{")));console.log(j.email||(j.account&&j.account.email)||"")}catch{console.log("")}})' 2>/dev/null) || acct=""
  spin_stop
  spin_start "Saving the coordinator image"
  if ! saveout=$("$root/bin/claude-cloud" coordinator image --save 2>&1); then
    spin_stop
    printf '%s\n' "$saveout" | tail -n 5 >&2
    bad "Saving the image failed. To retry: $root/bin/claude-cloud coordinator image --save" >&2
    coordinator_cleanup "$name"
    STATUS_COORD="failed (run $(rerun_cmd) again)"; return 0
  fi
  spin_stop
  if [[ $acct =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]]; then write_env CLAUDE_CLOUD_SNAPSHOT_ACCOUNT "$acct"; else acct=""; del_env CLAUDE_CLOUD_SNAPSHOT_ACCOUNT; fi
  STATUS_COORD="ready${acct:+ ($acct)}"
  ok "Coordinator image saved" "${acct:+$acct, }$SPIN_T"
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
    "Repository access: only the repos you will use with claude-cloud." "Permissions: Contents, read and write." \
    "Next, the Instabox CLI signs you in (if needed) and asks for the token." "Nothing shows as you paste."
  # The token goes from the terminal straight to the Instabox CLI; this script never sees it.
  npx --yes instabox@latest whoami >/dev/null 2>&1 || npx --yes instabox@latest login </dev/tty
  npx --yes instabox@latest secrets set GH_TOKEN --host github.com --host api.github.com </dev/tty
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
setup_provider() { # setup_provider NAME LABEL WHERE
  local name=$1 label=$2 where=$3 saved key
  saved=$(get_saved "$name")
  if [ -n "$saved" ]; then
    ok "$label key saved" "$(mask "" "$saved")"
    yn "Replace it?" || return 0
  fi
  drain_tty
  ask "$label key for open-model workers (optional)" "Get one at $where"
  ask_line "Paste it (nothing shows as you paste; Enter to skip):"
  read_secret key
  [ -n "$key" ] || { hint "Skipped $label."; return 0; }
  write_env "$name" "$key" || { bad "Could not write $(cfg)." >&2; exit 1; }
  ok "Saved the $label key" "$(mask "" "$key")"
  hint "Unlike GH_TOKEN, this key is stored on the worker machines that use it."
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

main() {
  if [ "${1:-}" != --check-only ] && [ ! -t 0 ]; then
    echo "install.sh asks for keys, so run it in a terminal: ./install.sh"; exit 1
  fi
  trap 'cleanup_capture; ui_cleanup; stty echo 2>/dev/null' EXIT
  trap 'exit 130' INT TERM
  [ "${1:-}" = --check-only ] || banner
  step 1 Tools
  check_prereqs || exit 1
  [ "${1:-}" = --check-only ] && exit 0
  ok "git, node, npm, curl and claude are installed"

  local root branch sha log
  root=$(cd "$(dirname "$0")" && pwd)
  log=$(mktemp)
  spin_start "Installing dependencies"
  (cd "$root" && npm install --silent --no-audit --no-fund) >"$log" 2>&1 || { spin_stop; cat "$log" >&2; rm -f "$log"; bad "npm install failed." >&2; exit 1; }
  spin_stop
  rm -f "$log"
  ok "Dependencies installed" "$SPIN_T"
  link_command "$root"
  link_skill "$root"
  LOCAL_ACCOUNT=$(claude_account)
  [ -z "$LOCAL_ACCOUNT" ] || ok "Your local Claude" "$LOCAL_ACCOUNT"

  warn_shell_env INSTABOX_API_KEY
  warn_shell_env CLAUDE_CODE_OAUTH_TOKEN
  step 2 "Instabox key"
  setup_instabox
  [ -n "$(get_saved INSTABOX_API_KEY)" ] || { bad "No Instabox key is saved, so setup cannot continue. Run $(rerun_cmd) again."; exit 1; }
  step 3 "Claude token"
  setup_claude
  step 4 "GitHub token, optional keys and coordinators"
  setup_github
  STATUS_GH=${GH_RESULT:-"not confirmed"}
  setup_provider PARTICLE_API_KEY Particle.ai https://platform.particle.ai
  setup_provider OPENROUTER_API_KEY OpenRouter https://openrouter.ai/keys
  setup_coordinators "$root"

  branch=$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null)
  sha=$(git -C "$root" rev-parse --short HEAD 2>/dev/null)
  box_open Summary
  summary_row "Instabox key" "$STATUS_INSTABOX"
  summary_row "Claude token" "$STATUS_CLAUDE"
  summary_row "GitHub token" "$STATUS_GH"
  summary_row "Coordinators" "$STATUS_COORD"
  box_close
  echo
  hint "claude-cloud runs from $root"
  hint "It is on branch $branch at $sha."
  hint "To update, run this in that folder: git pull && npm install"
  hint "To change a key later, run: claude-cloud setup"
  hint "Restart any open claude-cloud session to use the new keys."
  warn "Recommended: block direct pushes to your main branch on GitHub"
  hint "Settings > Rules > Rulesets. Subagents can push to any branch the token reaches."
  box_open Next
  box_text "In a repo with a github.com origin, run:"
  box_text "  claude-cloud" "$C_B$C_ACC"
  box_text "then type:"
  box_text "  use a subagent to run hostname, write it to proof.txt," "$C_ACC"
  box_text "  commit and push, and tell me the result" "$C_ACC"
  box_close
}

[ "${BASH_SOURCE[0]}" = "$0" ] && main "$@"
