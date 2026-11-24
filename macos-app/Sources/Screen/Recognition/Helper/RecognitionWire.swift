import CoreGraphics
import Darwin
import Evidence
import Foundation

enum RecognitionWire {
    static let maximumHeaderBytes = 64 * 1024
    static let maximumReplyBytes = 64 * 1024 * 1024

    struct Header: Codable, Equatable {
        let id: UInt64
        let crop: [Double]
        let core: [Double]
        let image: [Double]
        let width: Int
        let height: Int
        let bitmapInfo: UInt32
        let renderingIntent: Int32
        let profileBytes: Int
        let pixelBytes: Int
    }

    struct Reply: Codable, Equatable {
        let id: UInt64
        let text: [TextObservation]?
    }

    static func request(_ crop: TileCrop, id: UInt64) throws -> Data {
        let tile = crop.tile
        let header = Header(id: id, crop: values(tile.crop), core: values(tile.core), image: [tile.width, tile.height],
                            width: crop.width, height: crop.height, bitmapInfo: crop.bitmapInfo,
                            renderingIntent: crop.renderingIntent, profileBytes: crop.profile.count,
                            pixelBytes: crop.pixels.count)
        return prefixed(try JSONEncoder().encode(header)) + crop.profile + crop.pixels
    }

    static func readRequest(_ input: Int32) -> (id: UInt64, crop: TileCrop)? {
        guard let json = readPrefixed(input, maximum: maximumHeaderBytes),
              let header = try? JSONDecoder().decode(Header.self, from: json),
              let crop = rect(header.crop), let core = rect(header.core), header.image.count == 2,
              header.width == Int(crop.width), header.height == Int(crop.height),
              header.profileBytes > 0, header.profileBytes <= RawFrame.maximumICCBytes,
              header.pixelBytes == header.width * header.height * 4, header.pixelBytes <= RawFrame.maximumBytes,
              let profile = FileDescriptors.read(input, count: header.profileBytes),
              let pixels = FileDescriptors.read(input, count: header.pixelBytes) else { return nil }
        let tile = Tile(crop: crop, core: core, width: header.image[0], height: header.image[1])
        return (header.id, TileCrop(tile: tile, width: header.width, height: header.height,
                                    bitmapInfo: header.bitmapInfo, renderingIntent: header.renderingIntent,
                                    profile: profile, pixels: pixels))
    }

    static func reply(_ reply: Reply) throws -> Data {
        prefixed(try JSONEncoder().encode(reply))
    }

    static func readReply(_ input: Int32) -> Reply? {
        guard let json = readPrefixed(input, maximum: maximumReplyBytes) else { return nil }
        return try? JSONDecoder().decode(Reply.self, from: json)
    }

    private static func prefixed(_ body: Data) -> Data {
        var length = UInt32(body.count).littleEndian
        return Data(bytes: &length, count: 4) + body
    }

    private static func readPrefixed(_ input: Int32, maximum: Int) -> Data? {
        guard let prefix = FileDescriptors.read(input, count: 4) else { return nil }
        let length = Int(prefix.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self)) })
        guard length > 0, length <= maximum else { return nil }
        return FileDescriptors.read(input, count: length)
    }

    private static func values(_ rect: CGRect) -> [Double] {
        [rect.minX, rect.minY, rect.width, rect.height]
    }

    private static func rect(_ values: [Double]) -> CGRect? {
        guard values.count == 4, values.allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= Double(1 << 20) }) else { return nil }
        return CGRect(x: values[0], y: values[1], width: values[2], height: values[3])
    }
}

enum FileDescriptors {
    static func read(_ descriptor: Int32, count: Int) -> Data? {
        var data = Data(count: count)
        let complete = data.withUnsafeMutableBytes { buffer -> Bool in
            var done = 0
            while done < count {
                let got = Darwin.read(descriptor, buffer.baseAddress!.advanced(by: done), count - done)
                if got > 0 {
                    done += got
                } else if got < 0 && errno == EINTR {
                    continue
                } else {
                    return false
                }
            }
            return true
        }
        return complete ? data : nil
    }

    static func write(_ descriptor: Int32, _ data: Data) -> Bool {
        data.withUnsafeBytes { buffer in
            var done = 0
            while done < buffer.count {
                let wrote = Darwin.write(descriptor, buffer.baseAddress!.advanced(by: done), buffer.count - done)
                if wrote > 0 {
                    done += wrote
                } else if wrote < 0 && errno == EINTR {
                    continue
                } else {
                    return false
                }
            }
            return true
        }
    }
}
