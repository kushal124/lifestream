import Foundation
import Compression
import CryptoKit

enum Failure: Error { case codec, roundTrip }
func now() -> Double { ProcessInfo.processInfo.systemUptime }
func compress(_ data: Data, algorithm: compression_algorithm) throws -> Data {
    var destination = Data(count: data.count + 65536)
    let length = destination.withUnsafeMutableBytes { target in
        data.withUnsafeBytes { source in
            compression_encode_buffer(target.bindMemory(to: UInt8.self).baseAddress!, target.count,
                source.bindMemory(to: UInt8.self).baseAddress!, source.count, nil, algorithm)
        }
    }
    guard length > 0 else { throw Failure.codec }
    destination.count = length
    return destination
}
func expand(_ data: Data, originalSize: Int, algorithm: compression_algorithm) throws -> Data {
    var destination = Data(count: originalSize + 1)
    let length = destination.withUnsafeMutableBytes { target in
        data.withUnsafeBytes { source in
            compression_decode_buffer(target.bindMemory(to: UInt8.self).baseAddress!, target.count,
                source.bindMemory(to: UInt8.self).baseAddress!, source.count, nil, algorithm)
        }
    }
    guard length == originalSize else { throw Failure.codec }
    destination.count = length
    return destination
}
func fixture(nodeCount: Int, varied: Bool) throws -> Data {
    let nodes: [[String: Any]] = (0..<nodeCount).map { index in
        ["role": index % 5 == 0 ? "AXGroup" : "AXStaticText",
         "text": varied ? "Synthetic item \(index) value \(index * 7919)" : "Synthetic repeated interface label",
         "depth": index % 32,
         "bounds": ["x": Double(index % 20) * 12, "y": Double(index / 20) * 8,
                    "width": 100.0, "height": 20.0]]
    }
    let observation: [String: Any] = ["capturedAt": 1700000000000, "displayID": 1,
        "width": 3024, "height": 1964, "windows": [], "ocr": [], "status": "captured",
        "ocrStatus": "deferred-ax-present",
        "application": ["bundleID": "com.example.synthetic", "name": "Synthetic", "pid": 1],
        "accessibility": ["capturedAt": 1700000000000, "status": "partial", "nodes": nodes],
        "imageFile": "2023-11-14/synthetic-artifact/image.lsf"]
    return try JSONSerialization.data(withJSONObject: observation, options: [.sortedKeys])
}
let repetitions = 30
var rows: [[String: Any]] = []
for count in [7, 256, 1024] {
    for varied in [false, true] {
        let original = try fixture(nodeCount: count, varied: varied)
        let algorithms: [(String, compression_algorithm)] = [("lzfse", COMPRESSION_LZFSE), ("zlib", COMPRESSION_ZLIB)]
        for (name, algorithm) in algorithms {
            let warmup = try compress(original, algorithm: algorithm)
            guard try expand(warmup, originalSize: original.count, algorithm: algorithm) == original else { throw Failure.roundTrip }
            var encodeSeconds = 0.0, decodeSeconds = 0.0, parseSeconds = 0.0
            var encodedCount = 0
            for _ in 0..<repetitions {
                try autoreleasepool {
                    let start = now()
                    let packet = try compress(original, algorithm: algorithm)
                    let digest = Data(SHA256.hash(data: packet))
                    encodeSeconds += now() - start
                    encodedCount = packet.count
                    let decodeStart = now()
                    guard Data(SHA256.hash(data: packet)) == digest else { throw Failure.roundTrip }
                    let decoded = try expand(packet, originalSize: original.count, algorithm: algorithm)
                    decodeSeconds += now() - decodeStart
                    guard decoded == original else { throw Failure.roundTrip }
                    let parseStart = now()
                    _ = try JSONSerialization.jsonObject(with: decoded)
                    parseSeconds += now() - parseStart
                }
            }
            rows.append(["nodes": count, "variedText": varied, "algorithm": name,
                "originalBytes": original.count, "compressedBytes": encodedCount,
                "estimatedPacketBytes": encodedCount + 49,
                "estimatedStorageRatio": Double(original.count) / Double(encodedCount + 49),
                "meanEncodeIncludingDigestMilliseconds": encodeSeconds * 1000 / Double(repetitions),
                "meanDecodeIncludingDigestMilliseconds": decodeSeconds * 1000 / Double(repetitions),
                "meanFoundationJSONParseMilliseconds": parseSeconds * 1000 / Double(repetitions),
                "exactBytesRoundTrip": true])
        }
    }
}
let report: [String: Any] = ["syntheticOnly": true, "repetitions": repetitions,
    "warmupExcluded": true, "timingScope": "in-memory codec and packet checksum; excludes JSONEncoder, file IO, durability and query enumeration",
    "estimatedEnvelopeBytes": 49, "measurements": rows]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]))
FileHandle.standardOutput.write(Data("\n".utf8))
