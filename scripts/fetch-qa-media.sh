#!/usr/bin/env bash
set -euo pipefail

# Original fixtures: Nakiha/VoidPlayer@881eb5ccd706c33aa1ff35ab3a67ac3a226ccfba, resources/video.
url=https://github.com/Nakiha/VoidPlayer-QA-Fixtures/releases/download/qa-media-v1/qa-media-v1.tar.gz
sha256=788560b08178b43e439a35a68b2c3f4a3f1c0ed8b6ef35676531746589420fa6
archive="${1:?QA media cache directory required}/qa-media.tar.gz"
destination="${2:?QA media destination required}"

verify_archive() {
  printf '%s  %s\n' "$sha256" "$1" | shasum -a 256 -c -
}

if [[ ! -f "$archive" ]]; then
  mkdir -p "$(dirname "$archive")"
  partial="$(mktemp "$archive.XXXXXX")"
  trap 'rm -f "$partial"' EXIT
  curl --fail --silent --show-error --location --retry 3 -o "$partial" "$url"
  verify_archive "$partial"
  mv "$partial" "$archive"
else
  verify_archive "$archive"
fi

mkdir -p "$destination"
tar -xzf "$archive" -C "$destination"
