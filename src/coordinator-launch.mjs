// The launcher the tmux session "claude" runs on a coordinator machine (written there as
// ~/.config/cloudy-cloud/launch.sh, mode 700, by `coordinator start`). $1 is the coordinator's
// start command (the cloudy-cloud --remote-control line, unchanged).
//
// Each coordinator signs in to Claude for itself — the image carries no sign-in: a copied login's
// refresh token is single-use, so coordinators sharing one sign each other out. Before the session
// command runs, this script removes a credentials file the image may have copied in — once, at the
// first launch only, so a relaunch never deletes this coordinator's own sign-in. When `coordinator
// start` delivers a saved account's credential to the machine it writes the .credentials-removed
// marker itself before tmux starts, so this removal skips a delivered credential instead of
// deleting it. The sign-in check
// and `claude auth login` run under `env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY`: an API-key
// or token sign-in the session environment would satisfy is not the claude.ai sign-in each
// coordinator needs. The check requires both "loggedIn": true and "authMethod": "claude.ai". The
// login-active marker exists only while `claude auth login` is running, so the CLI can tell a live
// sign-in prompt on the pane from transcript text.
export const LAUNCH_SCRIPT = `#!/bin/sh
# Written by cloudy-cloud coordinator start. Runs inside the tmux session "claude".
conf="$HOME/.config/cloudy-cloud"
creds="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"
if [ ! -f "$conf/.credentials-removed" ]; then
  rm -f "$creds"
  if [ -e "$creds" ]; then
    echo "cloudy-cloud: could not remove the image credential at $creds — the session was not started"
    exit 1
  fi
  touch "$conf/.credentials-removed"
fi
status=$(env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY claude auth status --json 2>/dev/null)
if ! printf %s "$status" | grep -q '"loggedIn" *: *true' || ! printf %s "$status" | grep -q '"authMethod" *: *"claude\\.ai"'; then
  touch "$conf/login-active"
  trap 'rm -f "$conf/login-active"' EXIT
  env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY claude auth login
  rm -f "$conf/login-active"
  trap - EXIT
fi
exec sh -c "$1"
`;
