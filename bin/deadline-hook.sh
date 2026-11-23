#!/bin/sh
# cloudy-cloud deadline reminder hook (Claude Code command hook).
#
# Wired into the coordinator's launcher settings for the UserPromptSubmit and PostToolUse events.
# When CLOUDY_CLOUD_DELETE_AT is within 30 minutes it prints hookSpecificOutput.additionalContext,
# so the reminder reaches the session as context — never by typing into tmux.
# Coordinator machines only (CLOUDY_CLOUD_COORDINATOR exactly "1"), cheap, and always exit 0.
#
# stdin: the hook event JSON Claude Code sends (we echo its hook_event_name back in the output).

[ "${CLOUDY_CLOUD_COORDINATOR:-}" = "1" ] || exit 0
delete_at=${CLOUDY_CLOUD_DELETE_AT:-}
[ -n "$delete_at" ] || exit 0

# Epoch of the deadline: GNU date first (the machines are Linux), then BSD date, then a plain epoch.
deadline=$(date -d "$delete_at" +%s 2>/dev/null)
if [ -z "$deadline" ]; then
  norm=$(printf '%s' "$delete_at" | sed 's/\.[0-9][0-9]*Z$//; s/Z$//')
  deadline=$(date -j -u -f '%Y-%m-%dT%H:%M:%S' "$norm" +%s 2>/dev/null)
fi
case $delete_at in
  *[!0-9]*) ;;
  *) [ -n "$deadline" ] || deadline=$delete_at ;;
esac
case $deadline in
  ''|*[!0-9]*) exit 0 ;;
esac

now=$(date +%s 2>/dev/null)
case $now in ''|*[!0-9]*) exit 0 ;; esac
left=$(( deadline - now ))
[ "$left" -gt 1800 ] && exit 0
[ "$left" -lt 0 ] && left=0
mins=$(( left / 60 ))

# The event name is echoed back: hookSpecificOutput requires it to match the event that fired.
input=$(cat 2>/dev/null)
event=$(printf '%s' "$input" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
case $event in
  UserPromptSubmit|PostToolUse|PreToolUse|Notification|Stop|SubagentStop|SessionStart|SessionEnd|PreCompact) ;;
  *) event=UserPromptSubmit ;;
esac

printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"[cloudy-cloud] This machine is deleted at %s (in %s minutes). Commit your work and push it to a work branch (never to the default branch, main, master or release*; create a branch first if you are on one)."}}\n' \
  "$event" "$delete_at" "$mins"
exit 0
