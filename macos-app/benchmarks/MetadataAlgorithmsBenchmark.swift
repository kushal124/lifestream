import Spool
import Evidence
import Foundation
import Darwin
import Compression
import CryptoKit
private enum Failure: String, Error { case input, missing, oversized, compression, mismatch, malformed }
private struct Window: Decodable { let start: Double; let end: Double }
private struct Timer {
    let value: Double
    init() { var t = timespec(); clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &t); value = Double(t.tv_sec) + Double(t.tv_nsec) / 1e9 }
    var ms: Double { (Timer().value - value) * 1000 }
}
private func compressed(_ data: Data, algorithm: compression_algorithm) throws -> Data {
    var output = Data(count: data.count + data.count / 8 + 65536)
    let count = output.withUnsafeMutableBytes { dst in data.withUnsafeBytes { src in
        compression_encode_buffer(dst.bindMemory(to: UInt8.self).baseAddress!, dst.count,
                                  src.bindMemory(to: UInt8.self).baseAddress!, src.count, nil, algorithm)
    } }
    guard count > 0 else { throw Failure.compression }; output.count = count; return output
}
private func expanded(_ data: Data, count: Int, algorithm: compression_algorithm) throws -> Data {
    guard count > 0, count <= MetadataCodec.maximumJSONBytes else { throw Failure.oversized }
    var output = Data(count: count + 1)
    let valid = output.withUnsafeMutableBytes { dst in data.withUnsafeBytes { src in
        var stream = compression_stream(dst_ptr: dst.bindMemory(to: UInt8.self).baseAddress!, dst_size: dst.count,
                                        src_ptr: src.bindMemory(to: UInt8.self).baseAddress!, src_size: src.count, state: nil)
        guard compression_stream_init(&stream, COMPRESSION_STREAM_DECODE, algorithm) == COMPRESSION_STATUS_OK else { return false }
        defer { compression_stream_destroy(&stream) }
        stream.dst_ptr = dst.bindMemory(to: UInt8.self).baseAddress!; stream.dst_size = dst.count
        stream.src_ptr = src.bindMemory(to: UInt8.self).baseAddress!; stream.src_size = src.count
        while true {
            let beforeIn = stream.src_size, beforeOut = stream.dst_size
            let status = compression_stream_process(&stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
            if status == COMPRESSION_STATUS_END { return stream.src_size == 0 && dst.count - stream.dst_size == count }
            if status == COMPRESSION_STATUS_ERROR || stream.dst_size == 0 || (beforeIn == stream.src_size && beforeOut == stream.dst_size) { return false }
        }
    } }
    guard valid else { throw Failure.malformed }; output.count = count; return output
}
private func word(_ n: Int, _ data: inout Data) {
    var value = UInt32(n).littleEndian; withUnsafeBytes(of: &value) { data.append(contentsOf: $0) }
}
private func readWord(_ data: Data, _ offset: Int) -> Int { data.withUnsafeBytes { Int(UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: offset, as: UInt32.self))) } }
@main private enum Benchmark {
    static func main() {
        do { try run() } catch {
            let code = (error as? Failure)?.rawValue ?? "io-or-codec-error"
            FileHandle.standardError.write(Data(("Metadata diagnostic failed: " + code + "\n").utf8)); exit(1)
        }
    }
    static func run() throws {
        guard (2...3).contains(CommandLine.arguments.count) else { throw Failure.input }
        let window = try JSONDecoder().decode(Window.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        guard window.start.isFinite, window.end.isFinite, window.end > window.start, window.end - window.start <= 3600 else { throw Failure.input }
        let dir = CommandLine.arguments.count == 3 ? URL(fileURLWithPath: CommandLine.arguments[2]) : FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Lifestream Screen")
        let store = try CaptureStore(directory: dir, readOnly: true)
        let observations = try store.read(limit: 500, since: Date(timeIntervalSince1970: window.start)).filter { $0.capturedAt.timeIntervalSince1970 < window.end && $0.imageFile != nil }
        guard observations.count >= 20, observations.count < 500 else { throw Failure.missing }
        let algorithms: [(String, compression_algorithm)] = [("LZFSE", COMPRESSION_LZFSE), ("LZMA", COMPRESSION_LZMA), ("ZLIB", COMPRESSION_ZLIB)]
        var results: [[String: Any]] = []
        for sample in 0..<20 {
            try autoreleasepool {
                let observation = observations[sample * (observations.count - 1) / 19]
                guard let image = observation.imageFile else { throw Failure.missing }
                let bundle = dir.appendingPathComponent(image).deletingLastPathComponent()
                let compressedURL = bundle.appendingPathComponent("observation.lsm")
                let isPacket = FileManager.default.fileExists(atPath: compressedURL.path)
                let source = isPacket ? compressedURL : bundle.appendingPathComponent("observation.json")
                guard let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= MetadataCodec.maximumPacketBytes else { throw Failure.oversized }
                let original = try Data(contentsOf: source)
                let json = isPacket ? try MetadataCodec.decode(original) : original
                guard !json.isEmpty, json.count <= MetadataCodec.maximumJSONBytes else { throw Failure.oversized }
                var timer = Timer()
                let baseline = try MetadataCodec.encode(json); let enc = timer.ms
                timer = Timer(); let restored = try MetadataCodec.decode(baseline); let dec = timer.ms
                guard restored == json else { throw Failure.mismatch }
                results.append(["sample": sample, "algorithm": "production-LZFSE", "bytes": baseline.count, "rawBytes": json.count, "encodeCPUMilliseconds": enc, "decodeCPUMilliseconds": dec, "exact": true])
                for i in 0..<3 {
                    let (name, algorithm) = algorithms[(sample + i) % 3]
                    timer = Timer()
                    let candidate = try compressed(json, algorithm: algorithm)
                    let useCompressed = candidate.count < json.count
                    let payload = useCompressed ? candidate : json
                    var packet = Data("LSMDIAG1".utf8); packet.append(useCompressed ? 1 : 0)
                    word(json.count, &packet); word(payload.count, &packet)
                    packet.append(payload); packet.append(contentsOf: SHA256.hash(data: packet))
                    let encode = timer.ms
                    timer = Timer()
                    guard packet.count >= 50, packet.count <= MetadataCodec.maximumPacketBytes,
                          packet.prefix(8) == Data("LSMDIAG1".utf8), packet[8] <= 1,
                          Data(SHA256.hash(data: packet.dropLast(32))) == packet.suffix(32) else { throw Failure.malformed }
                    let rawCount = readWord(packet, 9), payloadCount = readWord(packet, 13)
                    guard rawCount > 0, rawCount <= MetadataCodec.maximumJSONBytes, payloadCount > 0,
                          payloadCount <= MetadataCodec.maximumJSONBytes, packet.count == payloadCount + 49 else { throw Failure.oversized }
                    let encodedPayload = packet.subdata(in: 17..<(17 + payloadCount))
                    let decoded: Data
                    if packet[8] == 1 { decoded = try expanded(encodedPayload, count: rawCount, algorithm: algorithm) }
                    else { guard payloadCount == rawCount else { throw Failure.malformed }; decoded = encodedPayload }
                    let decode = timer.ms
                    guard decoded == json else { throw Failure.mismatch }
                    results.append(["sample": sample, "algorithm": name, "bytes": packet.count, "rawBytes": json.count, "encodeCPUMilliseconds": encode, "decodeCPUMilliseconds": decode, "exact": true])
                }
            }
        }
        let report: [String: Any] = ["results": results,
            "scope": "20evenlyspaced captured metadata records, exact original JSON bytes. Includes compression/framing/SHA encode and bounded full-input-consumption decode/checksum; source reading and final byte equality excluded.49byte framing matches MetadataCodec budget. LSMDIAG1 is diagnostic only; algorithm external to packet. Native productionLZFSE baseline included. No JSON text, paths, images or identifiers emitted; no store writes."]
        print(String(decoding: try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted,.sortedKeys]), as: UTF8.self))
    }
}
