import Foundation
import Compression
import CryptoKit

public enum ScreenTextError: Error, Equatable, CustomStringConvertible {
    case malformed
    case sizeLimit
    case compressionFailed

    public var description: String {
        switch self {
        case .malformed:
            return "Screen text segment is malformed"
        case .sizeLimit:
            return "Screen text segment exceeds its supported size"
        case .compressionFailed:
            return "Screen text segment compression failed"
        }
    }
}

public enum ScreenText {
    public static let format = "org.lifestreamprotocol.screen-text/1"
    public static let windowMicroseconds = 300_000_000
    public static let maximumRawBytes = 64 * 1024 * 1024
    public static let maximumBodyBytes = 96 * 1024 * 1024
    public static let maximumFileBytes = 96 * 1024 * 1024

    static let movedMembers = [["accessibility", "nodes"], ["ocr"], ["windows"]]


    public struct Splice: Equatable, Sendable {
        public let at: Int
        public let before: Data
        public let array: Int
        public let after: Data

        public init(at: Int, before: Data, array: Int, after: Data) {
            self.at = at
            self.before = before
            self.array = array
            self.after = after
        }
    }

    public struct Reduction: Sendable {
        public let reduced: Data
        public let displayID: Int
        public let moved: [(at: Int, before: Data, array: Data, after: Data)]
    }

    public static func reduce(_ json: Data) -> Reduction? {
        let scan = JSONSpans(json)
        guard let top = scan.document() else {
            return nil
        }
        let display = scan.members(named: "displayID", in: top)
        guard display.count == 1,
              let displayID = Int(String(decoding: scan.bytes[display[0].value], as: UTF8.self)),
              displayID >= 0, scan.bytes[display[0].value].allSatisfy({ (0x30...0x39).contains($0) }) else {
            return nil
        }
        var spans: [(span: Range<Int>, value: Range<Int>)] = []
        for path in movedMembers {
            var object = top
            var found: (Int, JSONSpans.Object)?
            for (depth, name) in path.enumerated() {
                let named = scan.members(named: name, in: object)
                guard named.count <= 1 else {
                    return nil
                }
                guard let member = named.first else {
                    found = nil
                    break
                }
                if depth == path.count - 1 {
                    found = (object.members.firstIndex { $0.keyStart == member.keyStart }!, object)
                } else {
                    guard let inner = scan.object(at: member.value.lowerBound) else {
                        found = nil
                        break
                    }
                    guard inner.end == member.value.upperBound else {
                        return nil
                    }
                    object = inner
                }
            }
            guard let (index, object) = found else {
                continue
            }
            let member = object.members[index]
            guard scan.bytes[member.value.lowerBound] == UInt8(ascii: "[") else {
                return nil
            }
            let span: Range<Int>
            if index > 0 {
                span = object.members[index - 1].value.upperBound..<member.value.upperBound
            } else if object.members.count > 1 {
                span = member.keyStart..<object.members[1].keyStart
            } else {
                span = member.keyStart..<member.value.upperBound
            }
            spans.append((span, member.value))
        }
        guard !spans.isEmpty else {
            return nil
        }
        spans.sort { $0.span.lowerBound < $1.span.lowerBound }
        for (earlier, later) in zip(spans, spans.dropFirst()) where earlier.span.upperBound > later.span.lowerBound {
            return nil
        }
        var reduced = Data()
        reduced.reserveCapacity(json.count)
        var cursor = 0
        var removed = 0
        var moved: [(at: Int, before: Data, array: Data, after: Data)] = []
        for (span, value) in spans {
            reduced.append(contentsOf: scan.bytes[cursor..<span.lowerBound])
            moved.append((span.lowerBound - removed,
                          Data(scan.bytes[span.lowerBound..<value.lowerBound]),
                          Data(scan.bytes[value]),
                          Data(scan.bytes[value.upperBound..<span.upperBound])))
            removed += span.count
            cursor = span.upperBound
        }
        reduced.append(contentsOf: scan.bytes[cursor...])
        return Reduction(reduced: reduced, displayID: displayID, moved: moved.reversed())
    }

    public static func splice(_ reduced: Data, _ splices: [Splice], array: (Int) -> Data?) -> Data? {
        var result = Data()
        var cursor = 0
        let reduced = Data(reduced)
        for splice in splices.reversed() {
            guard splice.at >= cursor, splice.at <= reduced.count, let bytes = array(splice.array) else {
                return nil
            }
            result.append(reduced[cursor..<splice.at])
            result.append(splice.before)
            result.append(bytes)
            result.append(splice.after)
            cursor = splice.at
        }
        result.append(reduced[cursor...])
        return result
    }


    public struct Frame: Equatable, Sendable {
        public let bundle: String
        public let displayID: Int
        public let observationSHA256: String
        public let splices: [Splice]

        public init(bundle: String, displayID: Int, observationSHA256: String, splices: [Splice]) {
            self.bundle = bundle
            self.displayID = displayID
            self.observationSHA256 = observationSHA256
            self.splices = splices
        }
    }

    public struct Window: Equatable, Sendable {
        public let start: Int
        public let end: Int

        public init(start: Int, end: Int) {
            self.start = start
            self.end = end
        }

        public static func containing(_ microseconds: Int) -> Window {
            let start = microseconds - microseconds % windowMicroseconds
            return Window(start: start, end: start + windowMicroseconds)
        }
    }

    public static func body(window: Window, arrays: [(offset: Int, length: Int)], frames: [Frame], region: Data) -> Data {
        var header = "{\"format\":\"\(format)\",\"window\":[\(window.start),\(window.end)],\"arrays\":["
        header += arrays.map { "[\($0.offset),\($0.length)]" }.joined(separator: ",")
        header += "],\"frames\":["
        header += frames.map { frame in
            let splices = frame.splices.map { splice in
                "{\"at\":\(splice.at),\"before\":\(jsonString(splice.before)),\"array\":\(splice.array),"
                    + "\"after\":\(jsonString(splice.after))}"
            }
            return "{\"bundle\":\(jsonString(Data(frame.bundle.utf8))),\"displayID\":\(frame.displayID),"
                + "\"observationSHA256\":\"\(frame.observationSHA256)\",\"splices\":[\(splices.joined(separator: ","))]}"
        }.joined(separator: ",")
        header += "]}\n"
        var body = Data(header.utf8)
        body.append(region)
        return body
    }

    public struct Segment: Sendable {
        public let window: Window
        public let frames: [Frame]
        private let arrays: [Range<Int>]
        private let body: Data

        public init(body: Data) throws {
            let body = Data(body)
            guard let newline = body.firstIndex(of: 0x0A),
                  let header = try? JSONSerialization.jsonObject(with: body[..<newline]) as? [String: Any],
                  header["format"] as? String == ScreenText.format,
                  let window = header["window"] as? [Int], window.count == 2, window[0] < window[1],
                  let arrays = header["arrays"] as? [[Int]],
                  let frames = header["frames"] as? [[String: Any]] else {
                throw ScreenTextError.malformed
            }
            let region = newline + 1
            let regionCount = body.count - region
            self.arrays = try arrays.map { pair in
                guard pair.count == 2, pair[0] >= 0, pair[1] >= 0, pair[0] <= regionCount - pair[1] else {
                    throw ScreenTextError.malformed
                }
                return (region + pair[0])..<(region + pair[0] + pair[1])
            }
            let count = arrays.count
            self.frames = try frames.map { frame in
                guard let bundle = frame["bundle"] as? String,
                      let displayID = frame["displayID"] as? Int,
                      let digest = frame["observationSHA256"] as? String, ScreenText.isHexSHA256(digest),
                      let splices = frame["splices"] as? [[String: Any]] else {
                    throw ScreenTextError.malformed
                }
                return Frame(bundle: bundle, displayID: displayID, observationSHA256: digest, splices: try splices.map { splice in
                    guard let at = splice["at"] as? Int, at >= 0,
                          let before = splice["before"] as? String,
                          let array = splice["array"] as? Int, (0..<count).contains(array),
                          let after = splice["after"] as? String else {
                        throw ScreenTextError.malformed
                    }
                    return Splice(at: at, before: Data(before.utf8), array: array, after: Data(after.utf8))
                })
            }
            self.window = Window(start: window[0], end: window[1])
            self.body = body
        }

        public func array(_ index: Int) -> Data? {
            arrays.indices.contains(index) ? body[arrays[index]] : nil
        }

        public func rebuild(ordinal: Int, reduced: Data) -> Data? {
            guard frames.indices.contains(ordinal) else {
                return nil
            }
            return ScreenText.splice(reduced, frames[ordinal].splices, array: array)
        }

        public func proves(ordinal: Int, reduced: Data, observationSHA256: String) -> Bool {
            guard frames.indices.contains(ordinal),
                  frames[ordinal].observationSHA256 == observationSHA256,
                  let rebuilt = rebuild(ordinal: ordinal, reduced: reduced) else {
                return false
            }
            return ScreenText.hex(SHA256.hash(data: rebuilt)) == observationSHA256
        }
    }


    public static func compress(_ parts: [Data]) throws -> Data {
        guard let encoded = StreamCompression.encode(parts, algorithm: COMPRESSION_BROTLI) else {
            throw ScreenTextError.compressionFailed
        }
        return encoded
    }

    public static func decompress(_ file: Data) throws -> Data {
        guard file.count <= maximumFileBytes else {
            throw ScreenTextError.sizeLimit
        }
        guard let body = StreamCompression.decode(file, algorithm: COMPRESSION_BROTLI, maximumBytes: maximumBodyBytes) else {
            throw ScreenTextError.malformed
        }
        return body
    }


    public struct Manifest: Equatable, Sendable {
        public struct Entry: Equatable, Sendable {
            public let bundle: String
            public let ordinal: Int
            public let observationSHA256: String

            public init(bundle: String, ordinal: Int, observationSHA256: String) {
                self.bundle = bundle
                self.ordinal = ordinal
                self.observationSHA256 = observationSHA256
            }
        }

        public let segment: String
        public let segmentSHA256: Data
        public let window: Window
        public let frames: [Entry]

        public init(segment: String, segmentSHA256: Data, window: Window, frames: [Entry]) {
            self.segment = segment
            self.segmentSHA256 = segmentSHA256
            self.window = window
            self.frames = frames
        }

        public var encoded: Data {
            let entries = frames.map {
                "{\"bundle\":\(jsonString(Data($0.bundle.utf8))),\"ordinal\":\($0.ordinal),"
                    + "\"observationSHA256\":\"\($0.observationSHA256)\"}"
            }
            return Data(("{\"segment\":\(jsonString(Data(segment.utf8))),\"segmentSHA256\":\""
                + segmentSHA256.base64EncodedString() + "\",\"window\":[\(window.start),\(window.end)],"
                + "\"frames\":[\(entries.joined(separator: ","))],\"frameCount\":\(frames.count)}").utf8)
        }

        public static func decode(_ data: Data) -> Manifest? {
            guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let segment = object["segment"] as? String, isSegmentName(segment),
                  let spelled = object["segmentSHA256"] as? String,
                  let digest = Data(base64Encoded: spelled), digest.count == 32,
                  let window = object["window"] as? [Int], window.count == 2, window[0] < window[1],
                  let frames = object["frames"] as? [[String: Any]],
                  object["frameCount"] as? Int == frames.count else {
                return nil
            }
            var entries: [Entry] = []
            for (ordinal, frame) in frames.enumerated() {
                guard let bundle = frame["bundle"] as? String,
                      frame["ordinal"] as? Int == ordinal,
                      let digest = frame["observationSHA256"] as? String, isHexSHA256(digest) else {
                    return nil
                }
                entries.append(Entry(bundle: bundle, ordinal: ordinal, observationSHA256: digest))
            }
            return Manifest(segment: segment, segmentSHA256: digest, window: Window(start: window[0], end: window[1]),
                            frames: entries)
        }

        public static func window(prefix: Data) -> Window? {
            let text = String(decoding: prefix, as: UTF8.self)
            let pattern = #"^\{"segment":"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.lstext","segmentSHA256":"[A-Za-z0-9+/]{43}=","window":\[([0-9]{1,18}),([0-9]{1,18})\]"#
            guard let match = text.range(of: pattern, options: .regularExpression) else {
                return nil
            }
            let numbers = text[match].split(separator: "[").last!.dropLast().split(separator: ",")
            guard numbers.count == 2, let start = Int(numbers[0]), let end = Int(numbers[1]), start < end else {
                return nil
            }
            return Window(start: start, end: end)
        }

        public static let prefixBytes = 256
    }

    public static func isSegmentName(_ name: String) -> Bool {
        name.range(of: #"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.lstext$"#,
                   options: .regularExpression) != nil
    }

    public static func hex<D: Sequence>(_ digest: D) -> String where D.Element == UInt8 {
        digest.map { String(format: "%02x", $0) }.joined()
    }

    static func isHexSHA256(_ text: String) -> Bool {
        text.utf8.count == 64 && text.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
    }

    static func jsonString(_ bytes: Data) -> String {
        var out = Data("\"".utf8)
        for byte in bytes {
            switch byte {
            case UInt8(ascii: "\""): out.append(contentsOf: Array("\\\"".utf8))
            case UInt8(ascii: "\\"): out.append(contentsOf: Array("\\\\".utf8))
            case 0..<0x20: out.append(contentsOf: Array(String(format: "\\u%04x", byte).utf8))
            default: out.append(byte)
            }
        }
        out.append(UInt8(ascii: "\""))
        return String(decoding: out, as: UTF8.self)
    }
}
