
DEVELOPER_DIR=$(./xcode.sh)
export DEVELOPER_DIR
key_id=C769UKGLH3
issuer=0e260412-1401-4196-b8ab-4a595406cf42
key="$HOME/.appstoreconnect/private_keys/AuthKey_$key_id.p8"

for_contributors() {
  echo "these are the project's release tools, signed by its own team and key; to run the app on your own iPhone, build it from Xcode with your own team (docs/contributing/develop.md, \"Build the iPhone app\")" >&2
  exit 1
}

need_key() {
  [[ -f "$key" ]] && return
  echo "no App Store Connect key at $key" >&2
  for_contributors
}

profiles="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"

profile_for() {
  setopt local_options null_glob
  local want="$team.$1" now f created best="" newest=""
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  for f in "$profiles"/*.mobileprovision; do
    security cms -D -i "$f" > "$work/profile.plist" 2>/dev/null || continue
    [[ "$(plutil -extract Entitlements.application-identifier raw "$work/profile.plist")" == "$want" ]] || continue
    [[ "$(plutil -extract Entitlements.get-task-allow raw "$work/profile.plist" 2>/dev/null)" == true ]] || continue
    [[ "$(plutil -extract ExpirationDate raw "$work/profile.plist")" > "$now" ]] || continue
    created=$(plutil -extract CreationDate raw "$work/profile.plist")
    if [[ "$created" > "$newest" ]]; then newest=$created; best=$f; fi
  done
  if [[ -z "$best" ]]; then
    echo "no development profile for $1 in team $team: ./apple-setup.sh devices makes one" >&2
    for_contributors
  fi
  echo "$best"
}

identity="" bundle_prefix=""

set_key() {
  /usr/libexec/PlistBuddy -c "Delete :$2" "$1" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Add :$2 $3 $4" "$1"
}

sign_bundle() {
  local bundle="$1" source="$2" id profile ents="$work/$(basename "$1").entitlements"
  id=$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$bundle/Info.plist")
  profile=$(profile_for "$id")
  cp "$profile" "$bundle/embedded.mobileprovision"
  [[ -n "$identity" ]] || identity=$(security cms -D -i "$profile" | plutil -extract DeveloperCertificates.0 raw - \
    | base64 -d | openssl x509 -inform der -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')
  sed "s/\$(LIFESTREAM_BUNDLE_PREFIX)/$bundle_prefix/g" "$source" > "$ents"
  set_key "$ents" application-identifier string "$team.$id"
  set_key "$ents" com.apple.developer.team-identifier string "$team"
  set_key "$ents" get-task-allow bool true
  find "$bundle" -maxdepth 1 -name "*.dylib" -exec codesign --force --sign "$identity" --timestamp=none {} \;
  codesign --force --sign "$identity" --timestamp=none --generate-entitlement-der --entitlements "$ents" "$bundle"
}

sign_development_app() {
  bundle_prefix=$("$2/signing.sh" LIFESTREAM_BUNDLE_PREFIX)
  sign_bundle "$1/PlugIns/ShareExtension.appex" "$2/ShareExtension/ShareExtension${3:-}.entitlements"
  sign_bundle "$1/PlugIns/UsageMonitorExtension.appex" "$2/UsageMonitorExtension/UsageMonitorExtension${3:-}.entitlements"
  sign_bundle "$1" "$2/LifestreamCapture/Resources/LifestreamCapture${3:-}.entitlements"
  codesign --verify --deep --strict "$1"
}

friend_source() {
  git fetch --quiet origin main
  if ! git diff --quiet HEAD; then
    echo "A release build is a commit as main holds it: commit or set aside these changes first" >&2
    git status --short --untracked-files=no >&2
    exit 1
  fi
  git merge-base --is-ancestor HEAD origin/main ||
    { echo "$(git rev-parse --short HEAD) is not on origin/main: a release build is made from main as GitHub holds it" >&2; exit 1; }
  commit=$(git rev-parse --short HEAD)
  generation=$(git rev-list --count HEAD)
  mkdir -p "$1"
  git -C "$(git rev-parse --show-toplevel)" archive HEAD | tar -x -f - -C "$1"
}
