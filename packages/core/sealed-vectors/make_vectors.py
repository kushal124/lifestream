import hashlib
import io
import json
import os
import sys

import tink
from tink import cleartext_keyset_handle, streaming_aead
from tink.proto import aes_gcm_hkdf_streaming_pb2, common_pb2, tink_pb2

KEY = bytes(range(32))
TYPE_URL = "type.googleapis.com/google.crypto.tink.AesGcmHkdfStreamingKey"
HEADER = 40
TAG = 16
KEEP_FILES_UP_TO = 64 * 1024


def plain(n):
    return bytes(((i * 7) + ((i >> 8) * 13) + 1) & 0xFF for i in range(n))


def primitive(segment):
    params = aes_gcm_hkdf_streaming_pb2.AesGcmHkdfStreamingParams(
        ciphertext_segment_size=segment,
        derived_key_size=32,
        hkdf_hash_type=common_pb2.SHA256,
    )
    key = aes_gcm_hkdf_streaming_pb2.AesGcmHkdfStreamingKey(version=0, params=params, key_value=KEY)
    keyset = tink_pb2.Keyset(primary_key_id=1)
    entry = keyset.key.add()
    entry.key_data.type_url = TYPE_URL
    entry.key_data.value = key.SerializeToString()
    entry.key_data.key_material_type = tink_pb2.KeyData.SYMMETRIC
    entry.status = tink_pb2.ENABLED
    entry.key_id = 1
    entry.output_prefix_type = tink_pb2.RAW
    return cleartext_keyset_handle.from_keyset(keyset).primitive(streaming_aead.StreamingAead)


def lengths(segment):
    first = segment - HEADER - TAG
    later = segment - TAG
    return [0, 1, first - 1, first, first + 1, first + later + 1000, first + 2 * later]


def cases():
    for segment in (64 * 1024, 1024 * 1024):
        for n in lengths(segment):
            yield segment, "lifestream:1:blob", n
    yield 64 * 1024, "lifestream:1:day:2026-11-14", 64 * 1024 - HEADER - TAG + 1
    yield 1024 * 1024, "lifestream:1:day:2026-11-14", 1024 * 1024 - HEADER - TAG + 1


def seal(segment, ad, data):
    sink = io.BytesIO()
    sink.close = lambda: None
    with primitive(segment).new_encrypting_stream(sink, ad.encode()) as stream:
        stream.write(data)
    return sink.getvalue()


def unseal(segment, ad, data):
    with primitive(segment).new_decrypting_stream(io.BytesIO(data), ad.encode()) as stream:
        return stream.read()


def make(folder):
    vectors = []
    for segment, ad, n in cases():
        data = plain(n)
        sealed = seal(segment, ad, data)
        if unseal(segment, ad, sealed) != data:
            raise SystemExit(f"tink did not open its own file: {segment} {ad} {n}")
        name = f"tink-{segment // 1024}k-{ad.split(':')[2]}-{n}.bin"
        vector = {
            "segment": segment,
            "associatedData": ad,
            "plainLength": n,
            "sealedLength": len(sealed),
            "header": sealed[:HEADER].hex(),
            "sha256": hashlib.sha256(sealed).hexdigest(),
        }
        if segment <= KEEP_FILES_UP_TO:
            vector["file"] = name
            with open(os.path.join(folder, name), "wb") as out:
                out.write(sealed)
        vectors.append(vector)
    manifest = {"tink": "tink-py " + tink_version(), "key": KEY.hex(), "vectors": vectors}
    with open(os.path.join(folder, "tink.json"), "w") as out:
        json.dump(manifest, out, indent=2)
        out.write("\n")
    print(f"made {len(vectors)} vectors with {manifest['tink']}")


def open_ours(folder):
    with open(os.path.join(folder, "ours.json")) as source:
        manifest = json.load(source)
    failed = 0
    for vector in manifest["vectors"]:
        with open(os.path.join(folder, vector["file"]), "rb") as source:
            sealed = source.read()
        try:
            opened = unseal(vector["segment"], vector["associatedData"], sealed)
            ok = opened == plain(vector["plainLength"])
        except tink.TinkError as error:
            ok = False
            print(f"refused {vector['file']}: {error}")
        failed += 0 if ok else 1
        print(("opened " if ok else "FAILED ") + vector["file"])
    print(f"tink opened {len(manifest['vectors']) - failed} of {len(manifest['vectors'])} files sealed.ts wrote")
    sys.exit(1 if failed else 0)


def tink_version():
    from importlib.metadata import version
    return version("tink")


if __name__ == "__main__":
    streaming_aead.register()
    if len(sys.argv) != 3 or sys.argv[1] not in ("make", "open"):
        raise SystemExit("usage: make_vectors.py make|open <folder>")
    (make if sys.argv[1] == "make" else open_ours)(sys.argv[2])
