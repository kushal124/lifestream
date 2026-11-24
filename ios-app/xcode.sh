#!/usr/bin/env bash
set -euo pipefail
developer=${DEVELOPER_DIR:-$(xcode-select -p 2>/dev/null || true)}
developer=${developer%/}
if [[ "$developer" != */Contents/Developer || ! -f "${developer%/Developer}/Info.plist" ]]; then
  echo "no full Xcode at ${developer:-(none chosen)}: install Xcode 27 from the App Store, then run sudo xcode-select -s /Applications/Xcode.app, or set DEVELOPER_DIR to an Xcode's Contents/Developer" >&2
  exit 1
fi
echo "$developer"
