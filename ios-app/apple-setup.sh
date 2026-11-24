#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"

source ./sign-development.sh
need_key
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

jwt=$(xcrun altool --generate-jwt --apiKey "$key_id" --apiIssuer "$issuer" 2>&1 | grep -E '^eyJ' | tail -1)
[[ -n "$jwt" ]] || { echo "altool made no token from the API key $key_id" >&2; exit 1; }

api() {
  local reply code body=()
  [[ -n "${3:-}" ]] && body=(--data "$3")
  reply=$(curl -sS -g -X "$1" "https://api.appstoreconnect.apple.com$2" -H "Authorization: Bearer $jwt" \
    -H "Content-Type: application/json" "${body[@]}" -w $'\n%{http_code}')
  code=${reply##*$'\n'}
  reply=${reply%$'\n'*}
  if (( code >= 300 )); then
    echo "App Store Connect refused $1 $2 ($code):" >&2
    jq -r '.errors[]? | "  \(.title): \(.detail)"' <<< "$reply" >&2
    exit 1
  fi
  print -r -- "$reply"
}

bundle_id() {
  local id
  id=$(api GET "/v1/bundleIds?filter[identifier]=$1&filter[platform]=IOS&limit=200" \
    | jq -r --arg want "$1" '.data[] | select(.attributes.identifier == $want) | .id')
  [[ -n "$id" ]] || { echo "the team has no bundle id $1" >&2; exit 1; }
  echo "$id"
}

local_certificates() {
  local here
  here=$(security find-identity -v -p codesigning | awk '{ print $2 }')
  api GET "/v1/certificates?filter[certificateType]=$1&limit=200" | jq -r '.data[] | "\(.id) \(.attributes.certificateContent)"' \
    | while read -r id content; do
        sha=$(base64 -d <<< "$content" | openssl x509 -inform der -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')
        if grep -qx "$sha" <<< "$here"; then echo "$id"; fi
      done
}

made_profile=""
make_profile() {
  local name="$1" type="$2" bundle certificates devices old body made uuid
  bundle=$(bundle_id "$3")
  certificates=$(jq -nc --arg ids "$4" '$ids | split(" ") | map(select(. != "") | { type: "certificates", id: . })')
  devices=$(jq -nc --arg ids "$5" '$ids | split(" ") | map(select(. != "") | { type: "devices", id: . })')
  api GET "/v1/profiles?filter[name]=$(jq -rn --arg n "$name" '$n | @uri')&limit=200" \
    | jq -r --arg name "$name" '.data[] | select(.attributes.name == $name) | "\(.id) \(.attributes.uuid)"' \
    | while read -r old uuid; do
        api DELETE "/v1/profiles/$old" > /dev/null
        rm -f "$profiles/$uuid.mobileprovision"
      done
  body=$(jq -nc --arg name "$name" --arg type "$type" --arg bundle "$bundle" \
    --argjson certificates "$certificates" --argjson devices "$devices" '{ data: { type: "profiles",
      attributes: { name: $name, profileType: $type },
      relationships: { bundleId: { data: { type: "bundleIds", id: $bundle } }, certificates: { data: $certificates } }
        + (if $devices == [] then {} else { devices: { data: $devices } } end) } }')
  made=$(api POST /v1/profiles "$body")
  uuid=$(jq -r '.data.attributes.uuid' <<< "$made")
  mkdir -p "$profiles"
  made_profile="$profiles/$uuid.mobileprovision"
  jq -r '.data.attributes.profileContent' <<< "$made" | base64 -d > "$made_profile"
  echo "$name: made and installed ($uuid)"
}

distribution() {
  local certificate
  certificate=$(local_certificates DISTRIBUTION | head -1)
  if [[ -n "$certificate" ]]; then
    echo "Apple Distribution certificate: in the keychain ($certificate)"
  else
    /usr/bin/openssl genrsa -out "$work/key.pem" 2048 2>/dev/null
    /usr/bin/openssl req -new -key "$work/key.pem" -subj "/CN=Lifestream Apple Distribution" -out "$work/request.csr"
    made=$(api POST /v1/certificates "$(jq -nc --rawfile csr "$work/request.csr" \
      '{ data: { type: "certificates", attributes: { certificateType: "DISTRIBUTION", csrContent: $csr } } }')")
    certificate=$(jq -r '.data.id' <<< "$made")
    jq -r '.data.attributes.certificateContent' <<< "$made" | base64 -d > "$work/certificate.cer"
    /usr/bin/openssl x509 -inform der -in "$work/certificate.cer" -out "$work/certificate.pem"
    /usr/bin/openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/certificate.pem" -out "$work/identity.p12" -passout pass:lifestream
    security import "$work/identity.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P lifestream -T /usr/bin/codesign
    echo "Apple Distribution certificate: made and in the login keychain ($certificate)"
  fi
  make_profile "Lifestream App Store" IOS_APP_STORE org.lifestreamprotocol.phone "$certificate" ""
  if security cms -D -i "$made_profile" | grep -q family-controls; then
    echo "  It carries Family Controls: Apple has granted it for distribution."
  else
    echo "  It carries no Family Controls: TestFlight builds stay without Screen Time."
  fi
  make_profile "Lifestream Share App Store" IOS_APP_STORE org.lifestreamprotocol.phone.share "$certificate" ""
}

devices() {
  local entry udid name found certificates enabled
  for entry in "$@"; do
    udid=${entry%%=*}
    name=${entry#*=}
    [[ "$name" != "$entry" ]] || name="iPhone ${udid: -6}"
    [[ "$udid" =~ '^[0-9A-Fa-f-]{25,40}$' ]] || { echo "not an iPhone UDID: $udid" >&2; exit 64; }
    found=$(api GET "/v1/devices?filter[udid]=$udid&limit=200" | jq -r '.data[0] | select(.) | "\(.id) \(.attributes.status)"')
    if [[ -z "$found" ]]; then
      api POST /v1/devices "$(jq -nc --arg name "$name" --arg udid "$udid" \
        '{ data: { type: "devices", attributes: { name: $name, udid: $udid, platform: "IOS" } } }')" > /dev/null
      echo "$udid: registered as $name"
    elif [[ "${found#* }" == DISABLED ]]; then
      api PATCH "/v1/devices/${found%% *}" "$(jq -nc --arg id "${found%% *}" \
        '{ data: { type: "devices", id: $id, attributes: { status: "ENABLED" } } }')" > /dev/null
      echo "$udid: enabled again"
    else
      echo "$udid: already registered"
    fi
  done
  certificates=$(local_certificates DEVELOPMENT | tr '\n' ' ')
  [[ -n "${certificates// }" ]] || { echo "no development certificate of the team is in this Mac's keychain" >&2; exit 1; }
  enabled=$(api GET "/v1/devices?filter[platform]=IOS&filter[status]=ENABLED&limit=200" | jq -r '[.data[].id] | join(" ")')
  echo "Enabled iOS devices: $(wc -w <<< "$enabled" | tr -d ' ')"
  make_profile "Lifestream Development" IOS_APP_DEVELOPMENT org.lifestreamprotocol.phone "$certificates" "$enabled"
  make_profile "Lifestream Share Development" IOS_APP_DEVELOPMENT org.lifestreamprotocol.phone.share "$certificates" "$enabled"
  make_profile "Lifestream Usage Monitor Development" IOS_APP_DEVELOPMENT org.lifestreamprotocol.phone.usage-monitor "$certificates" "$enabled"
}

case "${1:-}" in
  distribution) distribution ;;
  devices) shift; devices "$@" ;;
  *) echo "usage: ./apple-setup.sh distribution | devices [<udid>[=<name>]...]" >&2; exit 64 ;;
esac
