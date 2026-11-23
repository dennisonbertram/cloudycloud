// The coordinator deadline watchdog: a small POSIX sh script uploaded to every coordinator machine as
// ~/watchdog.sh and run in its own tmux session (cc-watchdog) with CLOUDY_CLOUD_DELETE_AT in the environment.
// It warns the Claude session 30 and 10 minutes before the server deletes the machine, and 5 minutes before
// it commits leftover work in ~/repo and pushes it — never to the default branch or a release branch, never
// a force push, and it deletes nothing. Every action is logged to ~/watchdog.log.
// Kept as module text so tests can run the exact script a machine gets.
export const WATCHDOG_SCRIPT = `#!/bin/sh
# cloudy-cloud deadline watchdog. Log: ~/watchdog.log
# Test hooks: CC_NOW or CC_NOW_FILE (a file re-read every poll) fake "now" (epoch seconds);
# CC_WATCHDOG_POLL sets the poll interval in seconds (default 60).
log() { printf '%s %s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)" "$*" >> "$HOME/watchdog.log" 2>/dev/null || :; }

delete_at=\${CLOUDY_CLOUD_DELETE_AT:-}
if [ -z "$delete_at" ]; then log 'no CLOUDY_CLOUD_DELETE_AT; exiting'; exit 0; fi

# Epoch of the deadline: GNU date first (the machines are Linux), then BSD date, then a plain epoch.
deadline=$(date -d "$delete_at" +%s 2>/dev/null)
if [ -z "$deadline" ]; then
  norm=$(printf '%s' "$delete_at" | sed 's/\\.[0-9][0-9]*Z$//; s/Z$//')
  deadline=$(date -j -u -f '%Y-%m-%dT%H:%M:%S' "$norm" +%s 2>/dev/null)
fi
case $delete_at in
  *[!0-9]*) ;;
  *) [ -n "$deadline" ] || deadline=$delete_at ;;
esac
case $deadline in
  ''|*[!0-9]*) log "could not parse the delete time: $delete_at; exiting"; exit 0 ;;
esac

now() {
  if [ -n "\${CC_NOW_FILE:-}" ]; then cat "$CC_NOW_FILE" 2>/dev/null || date +%s
  elif [ -n "\${CC_NOW:-}" ]; then printf '%s' "$CC_NOW"
  else date +%s; fi
}
poll=\${CC_WATCHDOG_POLL:-60}
warn30=; warn10=

# Types the warning into the Claude session like a person at the keyboard.
warn() {
  mins=$(( ($deadline - $(now)) / 60 ))
  if tmux send-keys -t claude -l "[cloudy-cloud] This machine is deleted at $delete_at (in $mins minutes). Finish the current step, commit, and push your branch now." 2>/dev/null \
    && tmux send-keys -t claude Enter 2>/dev/null; then
    log "warned the Claude session ($mins minutes left)"
  else
    log 'could not reach the Claude session to warn it'
  fi
}

# The final step, 5 minutes before deletion: save whatever is left in ~/repo.
save() {
  if ! cd "$HOME/repo" 2>/dev/null; then log 'no ~/repo directory; nothing to save'; return 0; fi
  dirty=$(git status --porcelain 2>/dev/null)
  pushed=$(git branch -r --contains HEAD 2>/dev/null)
  if [ -z "$dirty" ] && [ -n "$pushed" ]; then log 'nothing to save: the tree is clean and every commit is pushed'; return 0; fi
  git add -A 2>/dev/null
  if git diff --cached --quiet 2>/dev/null; then : # nothing to commit (for example commits only)
  elif git commit -q -m 'WIP: automatic save before the machine is deleted' >/dev/null 2>&1; then
    log 'committed the remaining changes'
  else
    log 'the WIP commit failed'
  fi
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  default=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
  # A clone without origin/HEAD: ask the remote. main and master are always protected as well.
  [ -n "$default" ] || default=$(git ls-remote --symref origin HEAD 2>/dev/null | sed -n 's|^ref: refs/heads/\\([^[:space:]]*\\)[[:space:]]*HEAD$|\\1|p')
  stamp=$(now)
  # Never push to the default branch or a release branch; never force-push; never delete anything.
  case $branch in
    "$default"|main|master|release*|''|HEAD)
      if git push origin "HEAD:refs/heads/cloudy-cloud/wip-$stamp" >/dev/null 2>&1; then
        log "saved the work to cloudy-cloud/wip-$stamp (the current branch '$branch' must not be pushed to)"
      else
        log 'the push to cloudy-cloud/wip-* failed'
      fi ;;
    *)
      if git push origin "HEAD:refs/heads/$branch" >/dev/null 2>&1; then log "pushed $branch to origin"
      else log "the push of $branch failed"; fi ;;
  esac
}

while :; do
  left=$(( deadline - $(now) ))
  if [ "$left" -le 300 ]; then
    save
    log 'deadline reached; exiting'
    exit 0
  fi
  if [ "$left" -le 600 ] && [ -z "$warn10" ]; then warn10=1; warn; fi
  if [ "$left" -le 1800 ] && [ -z "$warn30" ]; then warn30=1; warn; fi
  sleep "$poll"
done
`;
