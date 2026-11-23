// The coordinator deadline watchdog: a small POSIX sh script uploaded to every coordinator machine as
// ~/watchdog.sh and run in its own tmux session (cc-watchdog) with CLOUDY_CLOUD_DELETE_AT and
// CLOUDY_CLOUD_COORDINATOR=1 in the environment. The deadline reminders reach the Claude session through
// a Claude Code hook (bin/deadline-hook.sh on the machine), so this script never touches the session.
// Starting 5 minutes before deletion it commits leftover tracked work in ~/repo (`git add -u` only —
// untracked files are logged, never staged) and pushes it: to the current branch unless it is the remote's
// default branch, main, master or a release branch, in which case it goes to cloudy-cloud/wip-<timestamp>.
// The remote is always asked for its default branch; an unreadable remote means "protected". A failed
// commit is never pushed; a failed push is retried every poll until the deadline, then the script exits
// non-zero. Every action is logged to ~/watchdog.log.
// Kept as module text so tests can run the exact script a machine gets.
export const WATCHDOG_SCRIPT = `#!/bin/sh
# cloudy-cloud deadline watchdog. Log: ~/watchdog.log
# Test hooks: CC_NOW or CC_NOW_FILE (a file re-read every poll) fake "now" (epoch seconds);
# CC_WATCHDOG_POLL sets the poll interval in seconds (default 60).
log() { printf '%s %s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)" "$*" >> "$HOME/watchdog.log" 2>/dev/null || :; }

# Coordinator machines only: the launcher exports CLOUDY_CLOUD_COORDINATOR=1 there.
if [ "\${CLOUDY_CLOUD_COORDINATOR:-}" != "1" ]; then log 'not a coordinator (CLOUDY_CLOUD_COORDINATOR is not "1"); exiting'; exit 0; fi

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

# The save step, retried every poll from 5 minutes before deletion until it succeeds or the
# deadline passes. Returns 0 when the work is safe: a clean pushed tree or a successful push.
save() {
  if ! cd "$HOME/repo" 2>/dev/null; then log 'no ~/repo directory; nothing to save'; return 0; fi

  # Untracked files are never staged — log them by name (never file contents) so nothing is lost silently.
  untracked_names=$(git status --porcelain 2>/dev/null | sed -n 's/^?? //p')
  untracked_count=$(git status --porcelain 2>/dev/null | grep -c '^?? ')
  if [ "$untracked_count" -gt 0 ]; then
    log "$untracked_count untracked file(s) left as-is, not pushed: $(printf '%s' "$untracked_names" | tr '\\n' ' ')"
  fi

  # "Clean" means no tracked change AND HEAD is exactly on origin/<branch>. A remote branch the
  # remote does not have counts as unpushed.
  dirty=$(git status --porcelain --untracked-files=no 2>/dev/null)
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  unpushed=1
  if [ "$branch" = 'HEAD' ] || [ -z "$branch" ]; then
    [ -n "$(git branch -r --contains HEAD 2>/dev/null)" ] && unpushed=
  else
    git fetch -q origin "$branch" >/dev/null 2>&1 || :
    if git rev-parse -q --verify "refs/remotes/origin/$branch" >/dev/null 2>&1 \
      && [ -z "$(git rev-list "origin/$branch..HEAD" 2>/dev/null)" ]; then unpushed=; fi
  fi
  if [ -z "$dirty" ] && [ -z "$unpushed" ]; then log 'nothing to save: the tree is clean and every commit is pushed'; return 0; fi

  # Stage tracked edits only and commit them; a failed commit is never pushed.
  git add -u >/dev/null 2>&1 || :
  if ! git diff --cached --quiet 2>/dev/null; then
    if git commit -q -m 'WIP: automatic save before the machine is deleted' >/dev/null 2>&1; then
      log 'committed the remaining changes'
    else
      log 'the WIP commit failed; will retry'
      return 1
    fi
  elif [ -n "$dirty" ]; then
    log 'the tracked changes could not be staged; will retry'
    return 1
  fi

  # Always ask the remote for its default branch. An unreachable remote or no answer means
  # "default unknown" — treat the current branch as protected and push the wip branch instead.
  default=$(git ls-remote --symref origin HEAD 2>/dev/null | sed -n 's|^ref: refs/heads/\\([^[:space:]]*\\)[[:space:]]*HEAD$|\\1|p')
  if [ -z "$default" ]; then
    log 'could not read the default branch from the remote; treating the current branch as protected'
  fi
  stamp=$(now)
  # Never push to the default branch, main, master or a release branch; never force-push; never delete.
  case $branch in
    ''|HEAD|main|master|release*) dest="cloudy-cloud/wip-$stamp" ;;
    "$default") dest="cloudy-cloud/wip-$stamp" ;;
    *) if [ -z "$default" ]; then dest="cloudy-cloud/wip-$stamp"; else dest=$branch; fi ;;
  esac
  if git push origin "HEAD:refs/heads/$dest" >/dev/null 2>&1; then
    case $dest in
      cloudy-cloud/wip-*) log "saved the work to $dest (the current branch '$branch' must not be pushed to)" ;;
      *) log "pushed $dest to origin" ;;
    esac
    return 0
  fi
  log "the push to $dest failed; will retry"
  return 1
}

while :; do
  now_s=$(now)
  left=$(( deadline - now_s ))
  if [ "$left" -le 300 ]; then
    if save; then
      log 'deadline reached; work saved; exiting'
      exit 0
    fi
    if [ "$now_s" -ge "$deadline" ]; then
      log 'deadline reached with the save unfinished; exiting'
      exit 1
    fi
  fi
  sleep "$poll"
done
`;
