// The coordinator deadline watchdog: a small POSIX sh script uploaded to every coordinator machine as
// ~/watchdog.sh and run in its own tmux session (cc-watchdog) with CLOUDY_CLOUD_DELETE_AT and
// CLOUDY_CLOUD_COORDINATOR=1 in the environment. The deadline reminders reach the Claude session through
// a Claude Code hook (bin/deadline-hook.sh on the machine), so this script never touches the session.
// Starting 5 minutes before deletion it saves leftover tracked work in ~/repo every poll: `git add -u`
// only (untracked files are logged, never staged), files already added in the index are unstaged and
// logged — a credential file staged before the watchdog ran must never be published by its commit.
// The push goes to the current branch unless it is protected — the push remote's own default branch
// (each configured pushurl is asked, since it can be a different repository than the fetch URL), main,
// master, a release branch or a detached HEAD — in which case it goes to cloudy-cloud/wip-<timestamp>.
// A failed fetch counts as "not pushed" (a stale origin/<branch> is never trusted). After a successful
// save the watchdog keeps polling — a later tracked edit is saved again — until one minute before the
// deadline. A failed commit is never pushed; a push rejected at the branch destination is not retried
// there but saved to a fresh cloudy-cloud/wip-<timestamp>. Every action is logged to ~/watchdog.log.
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

# The save step, run every poll from 5 minutes before deletion until the final minute. Returns 0 when the
# work is safe: a clean pushed tree or a successful push — a second pass then only pushes something new.
save() {
  if ! cd "$HOME/repo" 2>/dev/null; then log 'no ~/repo directory; nothing to save'; return 0; fi

  # Untracked files are never staged — log them by name (never file contents) so nothing is lost silently.
  untracked_names=$(git status --porcelain 2>/dev/null | sed -n 's/^?? //p')
  untracked_count=$(git status --porcelain 2>/dev/null | grep -c '^?? ')
  if [ "$untracked_count" -gt 0 ]; then
    log "$untracked_count untracked file(s) left as-is, not pushed: $(printf '%s' "$untracked_names" | tr '\\n' ' ')"
  fi

  # "Clean" means no tracked change AND HEAD is exactly on origin/<branch>. A remote branch the
  # remote does not have counts as unpushed — and so does a failed fetch: the cached remote ref
  # could be stale (a branch deleted remotely must not count as saved).
  dirty=$(git status --porcelain --untracked-files=no 2>/dev/null)
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  unpushed=1
  if [ "$branch" = 'HEAD' ] || [ -z "$branch" ]; then
    if git fetch -q origin >/dev/null 2>&1 && [ -n "$(git branch -r --contains HEAD 2>/dev/null)" ]; then unpushed=; fi
  elif git fetch -q origin "$branch" >/dev/null 2>&1 \
    && git rev-parse -q --verify "refs/remotes/origin/$branch" >/dev/null 2>&1 \
    && [ -z "$(git rev-list "origin/$branch..HEAD" 2>/dev/null)" ]; then unpushed=; fi
  if [ -z "$dirty" ] && [ -z "$unpushed" ]; then log 'nothing to save: the tree is clean and every commit is pushed'; return 0; fi

  # Stage tracked edits only. A file already added in the index (git add .env before the watchdog ran)
  # is not a tracked edit: reset the index and re-stage tracked edits — a credential file must never
  # ride a WIP commit. The names are logged (never contents) before the index is touched.
  added=$(git diff --cached --name-only --diff-filter=A 2>/dev/null)
  if [ -n "$added" ]; then
    log "unstaged newly added file(s), not committed: $(printf '%s' "$added" | tr '\\n' ' ')"
    git reset -q >/dev/null 2>&1 || :
  fi
  git add -u >/dev/null 2>&1 || :
  dirty=$(git status --porcelain --untracked-files=no 2>/dev/null)
  if [ -z "$dirty" ] && [ -z "$unpushed" ]; then log 'nothing to save: the tree is clean and every commit is pushed'; return 0; fi
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

  # Nothing new since the last successful push: the branch can stay unpushed (a protected branch or a
  # non-fast-forward keeps the branch ref behind) while the work is already safe on a wip branch.
  if [ -n "$saved_sha" ] && [ "$(git rev-parse HEAD 2>/dev/null)" = "$saved_sha" ]; then
    log 'nothing to save: the latest commit is already saved'
    return 0
  fi

  # The push destination's default branch decides "protected": a configured pushurl can name a different
  # repository than the fetch URL, so ask each pushurl for its HEAD symref (the fetch remote only when no
  # pushurl is set). Any unreadable remote or no answer means "default unknown" — protected.
  unknown=
  if [ -n "$(git config --get remote.origin.pushurl 2>/dev/null)" ]; then
    default=
    for u in $(git config --get-all remote.origin.pushurl 2>/dev/null); do
      d=$(git ls-remote --symref "$u" HEAD 2>/dev/null | sed -n 's|^ref: refs/heads/\\([^[:space:]]*\\)[[:space:]]*HEAD$|\\1|p')
      if [ -z "$d" ]; then unknown=1; else default="$default $d"; fi
    done
  else
    default=$(git ls-remote --symref origin HEAD 2>/dev/null | sed -n 's|^ref: refs/heads/\\([^[:space:]]*\\)[[:space:]]*HEAD$|\\1|p')
    [ -n "$default" ] || unknown=1
  fi
  if [ -n "$unknown" ]; then
    log 'could not read the default branch from the push remote; treating the current branch as protected'
  fi
  stamp=$(now)
  # Never push to a default branch, main, master, a release branch or detached HEAD; never force-push.
  dest=
  case $branch in
    ''|HEAD|main|master|release*) ;;
    *) if [ -z "$unknown" ]; then
         dest=$branch
         for d in $default; do [ "$branch" = "$d" ] && dest=; done
       fi ;;
  esac
  # A destination already rejected once is not retried: the work goes to a fresh wip branch instead.
  case " $rejected " in *" $branch "*) dest= ;; esac
  [ -n "$dest" ] || dest="cloudy-cloud/wip-$stamp"
  if out=$(git push origin "HEAD:refs/heads/$dest" 2>&1); then
    case $dest in
      cloudy-cloud/wip-*) log "saved the work to $dest (the current branch '$branch' must not be pushed to)" ;;
      *) log "pushed $dest to origin" ;;
    esac
    saved_sha=$(git rev-parse HEAD 2>/dev/null)
    return 0
  fi
  # A rejected push to the branch itself is probably a non-fast-forward: never retry that destination;
  # the work still lands on a fresh wip branch.
  if [ "$dest" = "$branch" ]; then
    rejected="$rejected $branch"
    dest="cloudy-cloud/wip-$stamp"
    if out=$(git push origin "HEAD:refs/heads/$dest" 2>&1); then
      log "the push to $branch was rejected; saved the work to $dest instead"
      saved_sha=$(git rev-parse HEAD 2>/dev/null)
      return 0
    fi
  fi
  # The first error line of the last failed push, trimmed to 200 characters, with credentials in URLs removed.
  why=$(printf '%s\\n' "$out" | sed 's|https://[^@ ]*@|https://|g' | grep -m1 -E '^ ! \\[remote rejected\\]|^(error|fatal):' | sed 's/^[[:space:]]*//' | cut -c1-200)
  if [ -n "$why" ]; then log "the push to $dest failed ($why); will retry"; else log "the push to $dest failed; will retry"; fi
  return 1
}

rejected=
saved_sha=
while :; do
  now_s=$(now)
  left=$(( deadline - now_s ))
  if [ "$left" -le 300 ]; then
    if save; then saved=1; else saved=; fi
    # One minute before deletion: stop polling — the last save just ran, and the machine is going away.
    if [ "$left" -le 60 ]; then
      if [ -n "$saved" ]; then
        log 'deadline reached; work saved; exiting'
        exit 0
      fi
      log 'deadline reached with the save unfinished; exiting'
      exit 1
    fi
  fi
  sleep "$poll"
done
`;
