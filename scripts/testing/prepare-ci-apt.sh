#!/usr/bin/env bash
set -euo pipefail

# The Azure archive has intermittently served packages at ~62 kB/s, exhausting
# browser-job deadlines before tests start. Keep Ubuntu's signed distributions
# and key configuration, and fetch packages from its primary HTTPS archive.
for source in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
  [[ -f "$source" ]] || continue
  sudo sed -i 's|http://azure.archive.ubuntu.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' "$source"
done
