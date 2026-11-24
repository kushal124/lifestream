#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"

base="https://get.lifestreamprotocol.org/7d17c9a3d9/phone"
source ./sign-development.sh
work="$PWD/.build/link-install"
src="$work/src"
derived="$work/derived"
app="$derived/Build/Products/Release-iphoneos/Lifestream.app"
out="$work/phone"
rm -rf "$src" "$out" "$work/Payload"; mkdir -p "$out"

friend_source "$src"
team=$("$src/ios-app/signing.sh" DEVELOPMENT_TEAM)
build=$generation

xcodebuild -project "$src/ios-app/LifestreamCapture.xcodeproj" -scheme LifestreamCapture -configuration Release \
  -sdk iphoneos -destination generic/platform=iOS -derivedDataPath "$derived" \
  CODE_SIGNING_ALLOWED=NO SWIFT_TREAT_WARNINGS_AS_ERRORS=YES CURRENT_PROJECT_VERSION="$build" \
  LIFESTREAM_COMMIT="$commit" LIFESTREAM_HOME_FLOOR="$generation" build > "$work/build.log" 2>&1 \
  || { grep -E "error:" "$work/build.log" | head -20; echo "build failed: $work/build.log"; exit 1; }

sign_development_app "$app" "$src/ios-app"

mkdir -p "$work/Payload"
cp -R "$app" "$work/Payload/"
(cd "$work" && zip -qry "$out/Lifestream.ipa" Payload)

bundle=$(plutil -extract CFBundleIdentifier raw "$app/Info.plist")
version=$(plutil -extract CFBundleShortVersionString raw "$app/Info.plist")
cat > "$out/manifest.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>items</key>
	<array>
		<dict>
			<key>assets</key>
			<array>
				<dict>
					<key>kind</key>
					<string>software-package</string>
					<key>url</key>
					<string>$base/Lifestream.ipa</string>
				</dict>
			</array>
			<key>metadata</key>
			<dict>
				<key>bundle-identifier</key>
				<string>$bundle</string>
				<key>bundle-version</key>
				<string>$version</string>
				<key>kind</key>
				<string>software</string>
				<key>title</key>
				<string>Lifestream</string>
			</dict>
		</dict>
	</array>
</dict>
</plist>
EOF
plutil -lint -s "$out/manifest.plist"

cat > "$out/index.html" <<EOF
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Install Lifestream</title>
<style>
  body { font: 17px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 48px 16px;
         background: #f5f5f2; color: #1c1c1e; text-align: center; }
  @media (prefers-color-scheme: dark) { body { background: #1c1c1e; color: #f5f5f2; } }
  a.install { display: inline-block; margin: 24px 0; padding: 14px 32px; border-radius: 12px;
              background: #1a874a; color: #fff; font-weight: 600; text-decoration: none; }
  p { max-width: 28em; margin: 0 auto; }
</style>
</head>
<body>
<h1>Lifestream</h1>
<a class="install" href="itms-services://?action=download-manifest&amp;url=$base/manifest.plist">Install Lifestream</a>
<p>Then turn on Developer Mode: Settings, Privacy &amp; Security, Developer Mode. The iPhone restarts; open Lifestream after it does.</p>
</body>
</html>
EOF

devices=$(security cms -D -i "$app/embedded.mobileprovision" | plutil -extract ProvisionedDevices raw -)
echo "Built $commit (build $build) into $out; devices its profile lists: $devices"
echo "Upload it to $base/:"
for file type in Lifestream.ipa application/octet-stream manifest.plist application/xml index.html text/html; do
  echo "  wrangler r2 object put \"lifestream-downloads/7d17c9a3d9/phone/$file\" --file \"$out/$file\" --content-type $type --remote"
done
