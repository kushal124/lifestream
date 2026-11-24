import Foundation
import Compression
import CryptoKit

public enum MetadataCodecError: Error, Equatable, CustomStringConvertible {
    case sizeLimit
    case invalidContainer
    case unsupportedVersion
    case integrityMismatch
    case compressionFailed

    public var description: String {
        switch self {
        case .sizeLimit:
            return "Capture metadata exceeds its supported encoded or decoded size limit"
        case .invalidContainer:
            return "Capture metadata is malformed, truncated, or has an invalid decompressed length"
        case .unsupportedVersion:
            return "Capture metadata uses an unsupported version"
        case .integrityMismatch:
            return "Capture metadata checksum does not match its stored bytes"
        case .compressionFailed:
            return "Capture metadata compression failed"
        }
    }
}

public enum MetadataCodec {
    public static let maximumJSONBytes = 16 * 1024 * 1024
    public static let maximumPacketBytes = maximumJSONBytes + 49
    private static let magic = Data("LSMETA01".utf8)

    public static func encode(_ json: Data) throws -> Data {
        guard !json.isEmpty, json.count <= maximumJSONBytes else {
            throw MetadataCodecError.sizeLimit
        }
        let compressed = BufferCompression.compress(json, algorithm: COMPRESSION_LZFSE, capacity: json.count)
            .flatMap { $0.count < json.count ? $0 : nil }
        let payload = compressed ?? json
        var packet = magic
        packet.append(compressed == nil ? 0 : 1)
        LittleEndian.appendWord(json.count, to: &packet)
        LittleEndian.appendWord(payload.count, to: &packet)
        packet.append(payload)
        packet.append(contentsOf: SHA256.hash(data: packet))
        return packet
    }

    public static func decode(_ packet: Data) throws -> Data {
        guard packet.count >= 50, packet.count <= maximumPacketBytes else {
            throw MetadataCodecError.sizeLimit
        }
        let packet = Data(packet)
        guard packet.prefix(6) == magic.prefix(6) else {
            throw MetadataCodecError.invalidContainer
        }
        guard packet.prefix(8) == magic else {
            throw MetadataCodecError.unsupportedVersion
        }
        guard Data(SHA256.hash(data: packet.dropLast(32))) == packet.suffix(32) else {
            throw MetadataCodecError.integrityMismatch
        }
        let kind = packet[8]
        guard kind <= 1 else {
            throw MetadataCodecError.invalidContainer
        }
        let decodedSize = LittleEndian.word(in: packet, at: 9)
        let payloadSize = LittleEndian.word(in: packet, at: 13)
        guard decodedSize > 0,
              decodedSize <= maximumJSONBytes,
              payloadSize > 0,
              payloadSize <= maximumJSONBytes,
              packet.count == 49 + payloadSize else {
            throw MetadataCodecError.sizeLimit
        }
        let payload = Data(packet[17..<(17 + payloadSize)])
        if kind == 0 {
            guard payloadSize == decodedSize else {
                throw MetadataCodecError.invalidContainer
            }
            return payload
        }
        guard let json = BufferCompression.expand(payload, count: decodedSize, algorithm: COMPRESSION_LZFSE) else {
            throw MetadataCodecError.invalidContainer
        }
        return json
    }
}
