#!/bin/sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
target=${1:-"$here/models/buffalo_l"}
url=https://github.com/deepinsight/insightface/releases/download/model-zoo/buffalo_l.zip

mkdir -p "$(dirname "$target")"
work=$(mktemp -d "$(dirname "$target")/.fetch.XXXXXX")
trap 'rm -rf "$work"' EXIT

curl --fail --location --retry 3 --silent --show-error --output "$work/buffalo_l.zip" "$url"
unzip -q -j "$work/buffalo_l.zip" det_10g.onnx w600k_r50.onnx -d "$work"

check() {
  actual=$(shasum -a 256 "$work/$1" | cut -d' ' -f1)
  if [ "$actual" != "$2" ]; then
    echo "fetch-models: $1 has SHA-256 $actual, not $2" >&2
    exit 1
  fi
}
check det_10g.onnx 5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91
check w600k_r50.onnx 4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43

mkdir -p "$target"
mv "$work/det_10g.onnx" "$work/w600k_r50.onnx" "$target/"
echo "fetch-models: $target holds det_10g.onnx and w600k_r50.onnx"
