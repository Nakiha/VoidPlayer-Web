#!/bin/sh
set -eu
# Initialize only once. Keep runtime configuration on the persistent data volume;
# image upgrades replace the template, never the user's saved configuration.
config=/data/voidplayer.config.json
if [ ! -e "$config" ]; then
  umask 077
  temporary=$(mktemp /data/.voidplayer-config.XXXXXX)
  trap 'rm -f "$temporary"' EXIT HUP INT TERM
  cp /app/voidplayer.config.example.json "$temporary"
  ln "$temporary" "$config" 2>/dev/null || [ -f "$config" ]
  rm -f "$temporary"
  trap - EXIT HUP INT TERM
fi
exec /app/voidplayer --data-dir /data "$@"
