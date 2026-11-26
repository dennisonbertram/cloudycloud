// The launcher the tmux session "claude" runs on a coordinator machine (written there as
// ~/.config/cloudy-cloud/launch.sh, mode 700, by `coordinator start`). $1 is the coordinator's
// start command (the cloudy-cloud --remote-control line, unchanged).
//
// Each coordinator signs in to Claude for itself — the image carries no sign-in: a copied login's
// refresh token is single-use, so coordinators sharing one sign each other out. Before the session
// command runs, this script removes a credentials file the image may have copied in — once, at the
// first launch only, so a relaunch never deletes this coordinator's own sign-in — then runs
// `claude auth login` when `claude auth status` reports no sign-in, and execs the command.
export const LAUNCH_SCRIPT = `#!/bin/sh
# Written by cloudy-cloud coordinator start. Runs inside the tmux session "claude".
conf="$HOME/.config/cloudy-cloud"
if [ ! -f "$conf/.credentials-removed" ]; then
  rm -f "$HOME/.claude/.credentials.json"
  touch "$conf/.credentials-removed"
fi
if ! claude auth status --json 2>/dev/null | grep -q '"loggedIn" *: *true'; then
  claude auth login
fi
exec sh -c "$1"
`;
