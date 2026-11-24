#!/usr/bin/env python3
"""Manual lossless WebP diagnostic; not part of automated tests or production.

python3 webp_benchmark.py /external/paths.json > /external/report.json
Input is a JSON array of PNG paths; only its first six entries are measured.
Temporary encoded files and raw pixels remain outside the repository and are removed.
No paths, image bytes, profiles, or recognized text are emitted.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import resource
import struct
import subprocess
import sys
import tempfile
import time
import zlib

CWEBP = "/opt/homebrew/bin/cwebp"
DWEBP = "/opt/homebrew/bin/dwebp"
FFMPEG = "/opt/homebrew/bin/ffmpeg"


def measured(command: list[str]) -> tuple[bytes, dict[str, float]]:
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    started = time.monotonic()
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=180, check=False)
    elapsed = time.monotonic() - started
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    if result.returncode:
        raise ValueError("subprocess-failed")
    return result.stdout, {
        "wallMilliseconds": elapsed * 1000,
        "childUserMilliseconds": (after.ru_utime - before.ru_utime) * 1000,
        "childSystemMilliseconds": (after.ru_stime - before.ru_stime) * 1000,
        "childCPUMilliseconds": ((after.ru_utime + after.ru_stime)
                                 - (before.ru_utime + before.ru_stime)) * 1000,
    }


def png_metadata(data: bytes) -> tuple[int, int, bytes | None]:
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("not-png")
    width = height = 0
    profile = None
    offset = 8
    while offset + 12 <= len(data):
        size = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + size]
        if len(payload) != size or offset + 12 + size > len(data):
            raise ValueError("invalid-png-chunk")
        if kind == b"IHDR":
            width, height, depth = struct.unpack_from(">IIB", payload)
            if depth > 8:
                raise ValueError("source-exceeds-8-bit-channel-check")
        elif kind == b"iCCP":
            split = payload.index(b"\0")
            if payload[split + 1] != 0:
                raise ValueError("unsupported-icc-compression")
            profile = zlib.decompress(payload[split + 2:])
        offset += size + 12
        if kind == b"IEND":
            break
    if width < 1 or height < 1:
        raise ValueError("invalid-png-dimensions")
    return width, height, profile


def webp_icc(data: bytes) -> bytes | None:
    if data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise ValueError("not-webp")
    offset = 12
    while offset + 8 <= len(data):
        kind = data[offset:offset + 4]
        size = struct.unpack_from("<I", data, offset + 4)[0]
        payload = data[offset + 8:offset + 8 + size]
        if len(payload) != size:
            raise ValueError("invalid-webp-chunk")
        if kind == b"ICCP":
            return payload
        offset += 8 + size + (size & 1)
    return None


def pam_rgba(data: bytes) -> tuple[int, int, bytes]:
    header, separator, pixels = data.partition(b"ENDHDR\n")
    if not separator or not header.startswith(b"P7\n"):
        raise ValueError("invalid-pam")
    fields = {}
    for line in header.splitlines()[1:]:
        if line and not line.startswith(b"#"):
            key, value = line.split(maxsplit=1)
            fields[key] = value
    width, height, depth = (int(fields[key]) for key in (b"WIDTH", b"HEIGHT", b"DEPTH"))
    if int(fields[b"MAXVAL"]) != 255 or depth != 4 or len(pixels) != width * height * 4:
        raise ValueError("pam-not-rgba8")
    return width, height, pixels


def main() -> None:
    if len(sys.argv) != 2:
        raise ValueError("expected-json-path-list")
    paths = json.loads(Path(sys.argv[1]).read_text())
    if not isinstance(paths, list) or not paths or not all(isinstance(p, str) for p in paths):
        raise ValueError("expected-nonempty-path-array")
    rows = []
    versions = {}
    for name, executable in (("cwebp", CWEBP), ("dwebp", DWEBP)):
        versions[name] = measured([executable, "-version"])[0].decode().strip()
    with tempfile.TemporaryDirectory(prefix="lifestream-webp-", dir="/private/tmp") as folder:
        for sample, path in enumerate(paths[:6]):
            try:
                source = Path(path).read_bytes()
                width, height, original_icc = png_metadata(source)
                rgba, baseline_decode = measured([
                    FFMPEG, "-v", "error", "-threads", "1", "-i", path,
                    "-frames:v", "1", "-threads", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
                ])
                if len(rgba) != width * height * 4:
                    raise ValueError("source-rgba-size-mismatch")
                reference_digest = hashlib.sha256(rgba).digest()
                methods = [0, 3, 6]
                methods = methods[sample % 3:] + methods[:sample % 3]
                for position, method in enumerate(methods):
                    try:
                        encoded_path = Path(folder) / "candidate.webp"
                        raw_path = Path(folder) / "candidate.pam"
                        _, encode_time = measured([
                            CWEBP, "-quiet", "-lossless", "-exact", "-m", str(method),
                            "-metadata", "all", path, "-o", str(encoded_path),
                        ])
                        encoded = encoded_path.read_bytes()
                        _, decode_time = measured([
                            DWEBP, "-quiet", str(encoded_path), "-pam", "-o", str(raw_path),
                        ])
                        decoded_width, decoded_height, decoded_rgba = pam_rgba(raw_path.read_bytes())
                        encoded_icc = webp_icc(encoded)
                        rows.append({
                            "sample": sample, "method": method, "executionOrder": position,
                            "sourceBytes": len(source), "encodedBytes": len(encoded),
                            "compressionRatio": len(source) / len(encoded),
                            "width": decoded_width, "height": decoded_height,
                            "dimensionsEqual": (width, height) == (decoded_width, decoded_height),
                            "rgbaBytesEqual": reference_digest == hashlib.sha256(decoded_rgba).digest(),
                            "sourceICCExists": original_icc is not None,
                            "encodedICCExists": encoded_icc is not None,
                            "iccBytesEqual": original_icc == encoded_icc,
                            "encode": encode_time, "decodeToRawPAM": decode_time,
                            "sourceDecodeToRawRGBA": baseline_decode,
                        })
                    except (ValueError, OSError, subprocess.SubprocessError):
                        rows.append({"sample": sample, "method": method, "error": "candidate-failed"})
            except (ValueError, OSError, subprocess.SubprocessError, zlib.error, KeyError, struct.error):
                rows.append({"sample": sample, "error": "source-check-failed"})
    print(json.dumps({
        "versions": versions,
        "timingScope": "CLI child CPU and wall; process startup, codec work and tool file IO included; no fsync durability guarantee",
        "pixelCheck": "exact decoded RGBA8 encoded-channel values; no ICC display transform",
        "metadataCheck": "decompressed source PNG iCCP versus WebP ICCP bytes; other metadata not validated",
        "reference": "existing PNG size, not a PNG re-encoding speed benchmark",
        "order": "compression methods rotated per sample; no excluded warmup",
        "measurements": rows,
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError):
        print("Benchmark failed; expected a readable external JSON array of PNG paths and installed codec tools.", file=sys.stderr)
        sys.exit(1)
