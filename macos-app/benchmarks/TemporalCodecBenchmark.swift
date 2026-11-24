import Foundation
import CoreGraphics
import ImageIO
import Compression
import UniformTypeIdentifiers

enum DiagnosticError: Error { case invalidInput, image, buffer, codec, reconstruction }
func monotonicTime() -> Double { ProcessInfo.processInfo.systemUptime }
struct Pixels {
    let width: Int
    let height: Int
    let data: Data
}
func decode(_ data: Data) throws -> CGImage {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0,
              [kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else { throw DiagnosticError.image }
    return image
}
func pixels(_ image: CGImage) throws -> Pixels {
    let (stride, rowOverflow) = image.width.multipliedReportingOverflow(by: 4)
    let (count, sizeOverflow) = stride.multipliedReportingOverflow(by: image.height)
    guard !rowOverflow, !sizeOverflow, count > 0, count <= 512 * 1024 * 1024,
          let space = CGColorSpace(name: CGColorSpace.sRGB) else { throw DiagnosticError.buffer }
    var data = Data(count: count)
    try data.withUnsafeMutableBytes { bytes in
        guard let context = CGContext(data: bytes.baseAddress, width: image.width, height: image.height,
            bitsPerComponent: 8, bytesPerRow: stride, space: space,
            bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue)
        else { throw DiagnosticError.image }
        context.setBlendMode(.copy)
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    }
    return Pixels(width: image.width, height: image.height, data: data)
}
struct NativeFormat: Equatable {
    let width: Int
    let height: Int
    let bytesPerRow: Int
    let bitmapInfo: UInt32
    let renderingIntent: Int32
    let icc: Data
}
struct NativePixels {
    let format: NativeFormat
    let data: Data
}
func nativePixels(_ image: CGImage) -> NativePixels? {
    guard image.bitsPerComponent == 8, image.bitsPerPixel == 32,
          let space = image.colorSpace, space.model == .rgb,
          let icc = space.copyICCData(),
          let provider = image.dataProvider, let bytes = provider.data else { return nil }
    let (minimum, overflow) = image.bytesPerRow.multipliedReportingOverflow(by: image.height)
    let data = bytes as Data
    guard !overflow, minimum > 0, data.count >= minimum, data.count <= 512 * 1024 * 1024 else { return nil }
    return NativePixels(format: NativeFormat(width: image.width, height: image.height,
        bytesPerRow: image.bytesPerRow, bitmapInfo: image.bitmapInfo.rawValue,
        renderingIntent: image.renderingIntent.rawValue, icc: icc as Data), data: data)
}
func png(_ frame: Pixels) throws -> Data {
    guard let provider = CGDataProvider(data: frame.data as CFData),
          let space = CGColorSpace(name: CGColorSpace.sRGB),
          let image = CGImage(width: frame.width, height: frame.height, bitsPerComponent: 8,
              bitsPerPixel: 32, bytesPerRow: frame.width * 4, space: space,
              bitmapInfo: CGBitmapInfo(rawValue: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue),
              provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    else { throw DiagnosticError.image }
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)
    else { throw DiagnosticError.image }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw DiagnosticError.image }
    return data as Data
}
func xor(_ lhs: Data, _ rhs: Data) throws -> Data {
    guard lhs.count == rhs.count else { throw DiagnosticError.buffer }
    var result = Data(count: lhs.count)
    result.withUnsafeMutableBytes { (out: UnsafeMutableRawBufferPointer) in
        lhs.withUnsafeBytes { (a: UnsafeRawBufferPointer) in
            rhs.withUnsafeBytes { (b: UnsafeRawBufferPointer) in
                for i in 0..<a.count { out[i] = a[i] ^ b[i] }
            }
        }
    }
    return result
}
func compress(_ source: Data, algorithm: compression_algorithm) throws -> Data {
    var output = Data(count: source.count + source.count / 8 + 65_536)
    let count = output.withUnsafeMutableBytes { (dst: UnsafeMutableRawBufferPointer) in
        source.withUnsafeBytes { (src: UnsafeRawBufferPointer) in
            compression_encode_buffer(dst.bindMemory(to: UInt8.self).baseAddress!, dst.count,
                src.bindMemory(to: UInt8.self).baseAddress!, src.count, nil, algorithm)
        }
    }
    guard count > 0 else { throw DiagnosticError.codec }
    output.count = count
    return output
}
func expand(_ source: Data, count: Int, algorithm: compression_algorithm) throws -> Data {
    var output = Data(count: count)
    let actual = output.withUnsafeMutableBytes { (dst: UnsafeMutableRawBufferPointer) in
        source.withUnsafeBytes { (src: UnsafeRawBufferPointer) in
            compression_decode_buffer(dst.bindMemory(to: UInt8.self).baseAddress!, dst.count,
                src.bindMemory(to: UInt8.self).baseAddress!, src.count, nil, algorithm)
        }
    }
    guard actual == count else { throw DiagnosticError.codec }
    return output
}
func appendWord(_ value: Int, to data: inout Data) {
    var word = UInt32(value).littleEndian
    withUnsafeBytes(of: &word) { data.append(contentsOf: $0) }
}
func sparseTiles(_ current: NativePixels, previous: NativePixels) throws -> Data {
    guard current.format == previous.format, current.data.count == previous.data.count else { throw DiagnosticError.buffer }
    let stride = current.format.bytesPerRow
    let rows = (current.data.count + stride - 1) / stride
    var packet = Data(count: 4)
    var tileCount = 0
    current.data.withUnsafeBytes { (a: UnsafeRawBufferPointer) in
        previous.data.withUnsafeBytes { (b: UnsafeRawBufferPointer) in
            for y in Swift.stride(from: 0, to: rows, by: 64) {
                let height = min(64, rows - y)
                for x in Swift.stride(from: 0, to: stride, by: 256) {
                    let width = min(256, stride - x)
                    var changed = false
                    for row in y..<(y + height) {
                        let offset = row * stride + x
                        let length = max(0, min(width, a.count - offset))
                        if length > 0 && memcmp(a.baseAddress!.advanced(by: offset), b.baseAddress!.advanced(by: offset), length) != 0 {
                            changed = true; break
                        }
                    }
                    if !changed { continue }
                    tileCount += 1
                    for value in [x, y, width, height] { appendWord(value, to: &packet) }
                    for row in y..<(y + height) {
                        let offset = row * stride + x
                        let length = max(0, min(width, a.count - offset))
                        if length > 0 { packet.append(a.baseAddress!.advanced(by: offset).assumingMemoryBound(to: UInt8.self), count: length) }
                    }
                }
            }
        }
    }
    var count = UInt32(tileCount).littleEndian
    withUnsafeBytes(of: &count) { packet.replaceSubrange(0..<4, with: $0) }
    return packet
}
func applyTiles(_ packet: Data, previous: Data, stride: Int) throws -> Data {
    var result = previous
    try packet.withUnsafeBytes { (src: UnsafeRawBufferPointer) in
        var cursor = 0
        func word() throws -> Int {
            guard cursor <= src.count - 4 else { throw DiagnosticError.buffer }
            defer { cursor += 4 }
            return Int(UInt32(littleEndian: src.loadUnaligned(fromByteOffset: cursor, as: UInt32.self)))
        }
        let count = try word()
        let rows = (previous.count + stride - 1) / stride
        guard count <= ((stride + 255) / 256) * ((rows + 63) / 64) else { throw DiagnosticError.buffer }
        try result.withUnsafeMutableBytes { (dst: UnsafeMutableRawBufferPointer) in
            for _ in 0..<count {
                let x = try word(), y = try word(), width = try word(), height = try word()
                guard x < stride, y < rows, width > 0, width <= 256, width <= stride - x,
                      height > 0, height <= 64, height <= rows - y else { throw DiagnosticError.buffer }
                for row in y..<(y + height) {
                    let offset = row * stride + x
                    let length = max(0, min(width, dst.count - offset))
                    guard length <= src.count - cursor else { throw DiagnosticError.buffer }
                    if length > 0 { memcpy(dst.baseAddress!.advanced(by: offset), src.baseAddress!.advanced(by: cursor), length) }
                    cursor += length
                }
            }
        }
        guard cursor == src.count else { throw DiagnosticError.buffer }
    }
    return result
}
func originalPNGEncodeEstimate(_ image: CGImage) throws -> Double {
    let start = monotonicTime()
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { throw DiagnosticError.image }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw DiagnosticError.image }
    return monotonicTime() - start
}
struct Totals {
    var bytes = 0
    var encodeSeconds = 0.0
    var decodeSeconds = 0.0
    var exactFrames = 0
    var previousDecoded: Data?
    var json: [String: Any] {
        ["payloadBytes": bytes, "encodeMilliseconds": encodeSeconds * 1000,
         "decodeMilliseconds": decodeSeconds * 1000, "exactReconstructedFrames": exactFrames]
    }
}
do {
    guard CommandLine.arguments.count == 2 || CommandLine.arguments.count == 3 else { throw DiagnosticError.invalidInput }
    let limit = CommandLine.arguments.count == 3 ? Int(CommandLine.arguments[2]) ?? 0 : 20
    guard (1...1000).contains(limit) else { throw DiagnosticError.invalidInput }
    let list = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
    let paths = list.split(whereSeparator: \.isNewline).map(String.init)
    guard !paths.isEmpty else { throw DiagnosticError.invalidInput }
    let algorithms: [(String, compression_algorithm)] = [("xor-lzfse", COMPRESSION_LZFSE), ("xor-zlib", COMPRESSION_ZLIB)]
    var totals = ["xor-lzfse": Totals(), "xor-zlib": Totals(), "png": Totals()]
    var previous: Pixels?
    var previousNative: NativePixels?
    var nativeTotals = ["xor-lzfse": Totals(), "xor-zlib": Totals()]
    var nativeFrames = 0, nativeKeyframes = 0, nativeSkipped = 0, nativeRawBytes = 0
    var nativeExtraction = 0.0
    var tileTotals = ["tiles-lzfse": Totals(), "tiles-zlib": Totals()]
    var tileKeyframeEncodeEstimate = 0.0
    var tileUncompressedPacketBytes = 0
    var originalBytes = 0, rawBytes = 0, frames = 0, keyframes = 0
    var originalDecode = 0.0, conversion = 0.0
    for path in paths.prefix(limit) {
        try autoreleasepool {
            let original = try Data(contentsOf: URL(fileURLWithPath: path))
            originalBytes += original.count
            var start = monotonicTime()
            let image = try decode(original)
            originalDecode += monotonicTime() - start
            start = monotonicTime()
            let native = nativePixels(image)
            nativeExtraction += monotonicTime() - start
            if let native {
                let nativeKeyframe = frames % 30 == 0 || previousNative?.format != native.format || previousNative?.data.count != native.data.count
                if nativeKeyframe { nativeKeyframes += 1 }
                for (name, algorithm) in algorithms {
                    start = monotonicTime()
                    let input = nativeKeyframe ? native.data : try xor(native.data, previousNative!.data)
                    let encoded = try compress(input, algorithm: algorithm)
                    nativeTotals[name]!.encodeSeconds += monotonicTime() - start
                    nativeTotals[name]!.bytes += encoded.count
                    start = monotonicTime()
                    let delta = try expand(encoded, count: native.data.count, algorithm: algorithm)
                    let reconstructed = nativeKeyframe ? delta : try xor(delta, nativeTotals[name]!.previousDecoded!)
                    nativeTotals[name]!.decodeSeconds += monotonicTime() - start
                    guard reconstructed == native.data else { throw DiagnosticError.reconstruction }
                    nativeTotals[name]!.exactFrames += 1
                    nativeTotals[name]!.previousDecoded = reconstructed
                }
                if nativeKeyframe { tileKeyframeEncodeEstimate += try originalPNGEncodeEstimate(image) }
                for (name, algorithm) in [("tiles-lzfse", COMPRESSION_LZFSE), ("tiles-zlib", COMPRESSION_ZLIB)] {
                    let reconstructed: Data
                    if nativeKeyframe {
                        tileTotals[name]!.bytes += original.count + 1
                        start = monotonicTime()
                        guard let decoded = nativePixels(try decode(original)), decoded.format == native.format else { throw DiagnosticError.reconstruction }
                        reconstructed = decoded.data
                        tileTotals[name]!.decodeSeconds += monotonicTime() - start
                    } else {
                        start = monotonicTime()
                        let packet = try sparseTiles(native, previous: previousNative!)
                        let encoded = try compress(packet, algorithm: algorithm)
                        tileTotals[name]!.encodeSeconds += monotonicTime() - start
                        tileTotals[name]!.bytes += encoded.count + 5
                        if name == "tiles-lzfse" { tileUncompressedPacketBytes += packet.count }
                        start = monotonicTime()
                        let decoded = try expand(encoded, count: packet.count, algorithm: algorithm)
                        reconstructed = try applyTiles(decoded, previous: tileTotals[name]!.previousDecoded!, stride: native.format.bytesPerRow)
                        tileTotals[name]!.decodeSeconds += monotonicTime() - start
                    }
                    guard reconstructed == native.data else { throw DiagnosticError.reconstruction }
                    tileTotals[name]!.exactFrames += 1
                    tileTotals[name]!.previousDecoded = reconstructed
                }
                nativeFrames += 1
                nativeRawBytes += native.data.count
                previousNative = native
            } else {
                nativeSkipped += 1
                previousNative = nil
            }
            start = monotonicTime()
            let frame = try pixels(image)
            conversion += monotonicTime() - start
            rawBytes += frame.data.count
            let keyframe = frames % 30 == 0 || previous?.width != frame.width || previous?.height != frame.height
            if keyframe { keyframes += 1 }
            for (name, algorithm) in algorithms {
                start = monotonicTime()
                let input = keyframe ? frame.data : try xor(frame.data, previous!.data)
                let encoded = try compress(input, algorithm: algorithm)
                totals[name]!.encodeSeconds += monotonicTime() - start
                totals[name]!.bytes += encoded.count
                start = monotonicTime()
                let delta = try expand(encoded, count: frame.data.count, algorithm: algorithm)
                let reconstructed = keyframe ? delta : try xor(delta, totals[name]!.previousDecoded!)
                totals[name]!.decodeSeconds += monotonicTime() - start
                guard reconstructed == frame.data else { throw DiagnosticError.reconstruction }
                totals[name]!.exactFrames += 1
                totals[name]!.previousDecoded = reconstructed
            }
            start = monotonicTime()
            let encodedPNG = try png(frame)
            totals["png"]!.encodeSeconds += monotonicTime() - start
            totals["png"]!.bytes += encodedPNG.count
            start = monotonicTime()
            let decodedPNG = try pixels(decode(encodedPNG))
            totals["png"]!.decodeSeconds += monotonicTime() - start
            if decodedPNG.width == frame.width && decodedPNG.height == frame.height && decodedPNG.data == frame.data {
                totals["png"]!.exactFrames += 1
            }
            previous = frame
            frames += 1
        }
    }
    let report: [String: Any] = [
        "frames": frames, "keyframes": keyframes, "keyframeInterval": 30,
        "originalPNGBytes": originalBytes, "rawRGBABytes": rawBytes,
        "originalPNGDecodeMilliseconds": originalDecode * 1000,
        "originalToRGBAConversionMilliseconds": conversion * 1000,
        "pixelIdentity": "Exact rendered sRGB RGBA8 premultiplied bytes; original provider-byte identity is not asserted",
        "byteAccounting": "Compressed payload only; excludes any future container/index framing",
        "timingAccounting": "Temporal encode includes XOR; decode includes reconstruction. PNG decode includes RGBA rendering. File I/O and exact validation excluded.",
        "nativeProvider": [
            "frames": nativeFrames, "skippedUnsupportedFrames": nativeSkipped, "keyframes": nativeKeyframes,
            "rawBytes": nativeRawBytes, "extractionMilliseconds": nativeExtraction * 1000,
            "pixelIdentity": "Exact decoded PNG provider bytes including row padding; no color conversion",
            "formatPolicy": "8-bit components, 32-bit RGB pixels with ICC data; geometry, stride, bitmap info, rendering intent, ICC or buffer size changes force keyframe",
            "containerRequirement": "A real format must preserve ICC, geometry, stride, bitmap info and rendering intent; metadata bytes excluded here",
            "codecs": nativeTotals.mapValues(\.json),
            "sparseTiles": [
                "codecs": tileTotals.mapValues { value -> [String: Any] in
                    var result = value.json
                    result["estimatedEncodeIncludingPNGKeyframesMilliseconds"] = (value.encodeSeconds + tileKeyframeEncodeEstimate) * 1000
                    return result
                },
                "keyframePNGReencodeEstimateMilliseconds": tileKeyframeEncodeEstimate * 1000,
                "uncompressedDeltaPacketBytes": tileUncompressedPacketBytes,
                "policy": "Exact replacement tiles 256 bytes wide by 64 rows; includes padding/tail; original PNG keyframe every30 or format change",
                "byteAccounting": "Original PNG keyframes plus compressed tile packets, tile coordinates, frame tags and decoded-length fields; future seek index excluded",
                "timingAccounting": "encodeMilliseconds measures delta scan/pack/compress only; estimatedEncodeIncludingPNGKeyframesMilliseconds also charges measured native PNG re-encoding. Existing original PNG bytes are used for reconstruction."
            ]
        ],
        "codecs": totals.mapValues(\.json)
    ]
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]))
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    FileHandle.standardError.write(Data("Temporal codec diagnostic failed.\n".utf8))
    exit(1)
}
