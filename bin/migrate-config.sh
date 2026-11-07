# Sourced by bin/cloudy-cloud and install.sh (POSIX sh). The product was called claude-cloud before.
# migrate_config copies ~/.config/claude-cloud to ~/.config/cloudy-cloud once and renames the
# CLAUDE_CLOUD_ key names in env. It never prints values and never changes the old folder.
migrate_config() {
  [ -z "${CLOUDY_CLOUD_CONFIG:-}" ] || return 0
  _old=$HOME/.config/claude-cloud; _new=$HOME/.config/cloudy-cloud
  { [ -d "$_old" ] && [ ! -e "$_new" ]; } || return 0
  _tmp=$_new.tmp.$$
  rm -rf "$_tmp"
  if (umask 077; cp -Rp "$_old" "$_tmp" &&
      { [ ! -f "$_tmp/env" ] || { sed 's/^CLAUDE_CLOUD_/CLOUDY_CLOUD_/' "$_old/env" > "$_tmp/env.new" && mv "$_tmp/env.new" "$_tmp/env" && chmod 600 "$_tmp/env"; }; } &&
      mv "$_tmp" "$_new"); then
    echo "  Moved your saved keys from ~/.config/claude-cloud to ~/.config/cloudy-cloud (the old folder is left in place)."
  else
    rm -rf "$_tmp"
  fi
}
