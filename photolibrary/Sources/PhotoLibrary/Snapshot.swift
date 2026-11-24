import CryptoKit
import Foundation
import UniformTypeIdentifiers

public struct PhotoResource: Sendable, Hashable {
    public var typeRaw: Int
    public var uti: String
    public var originalFilename: String
    public var size: Int64?

    public init(typeRaw: Int, uti: String, originalFilename: String, size: Int64? = nil) {
        self.typeRaw = typeRaw; self.uti = uti; self.originalFilename = originalFilename; self.size = size
    }

    public var type: String { Wire.resourceTypeName(typeRaw) }

    func isSameFile(as other: PhotoResource) -> Bool {
        typeRaw == other.typeRaw && uti == other.uti && originalFilename == other.originalFilename
    }
}

public struct PhotoSnapshot: Sendable, Equatable {
    public var localIdentifier: String
    public var cloudIdentifier: String?
    public var mediaTypeRaw: Int
    public var mediaSubtypesRaw: UInt
    public var creationDate: Date?
    public var modificationDate: Date?
    public var pixelWidth: Int
    public var pixelHeight: Int
    public var duration: Double
    public var isFavorite: Bool
    public var isHidden: Bool
    public var sourceTypeRaw: UInt
    public var latitude: Double?
    public var longitude: Double?
    public var burstIdentifier: String?
    public var representsBurst: Bool
    public var resources: [PhotoResource]

    public init(localIdentifier: String, cloudIdentifier: String? = nil, mediaTypeRaw: Int = 1, mediaSubtypesRaw: UInt = 0,
                creationDate: Date?, modificationDate: Date?, pixelWidth: Int = 0, pixelHeight: Int = 0, duration: Double = 0,
                isFavorite: Bool = false, isHidden: Bool = false, sourceTypeRaw: UInt = 1, latitude: Double? = nil,
                longitude: Double? = nil, burstIdentifier: String? = nil, representsBurst: Bool = false,
                resources: [PhotoResource]) {
        self.localIdentifier = localIdentifier; self.cloudIdentifier = cloudIdentifier
        self.mediaTypeRaw = mediaTypeRaw; self.mediaSubtypesRaw = mediaSubtypesRaw
        self.creationDate = creationDate; self.modificationDate = modificationDate
        self.pixelWidth = pixelWidth; self.pixelHeight = pixelHeight; self.duration = duration
        self.isFavorite = isFavorite; self.isHidden = isHidden; self.sourceTypeRaw = sourceTypeRaw
        self.latitude = latitude; self.longitude = longitude
        self.burstIdentifier = burstIdentifier; self.representsBurst = representsBurst
        self.resources = resources
    }
}

public enum ResourceState: Sendable, Equatable {
    case blob(hash: String, bytes: UInt64)
    case absent(Refusal?)
}

public enum Refusal: String, Sendable, Equatable {
    case notFound = "not_found"
    case downloadFailed = "download_failed"
}

public struct PhotoEntry: Sendable, Equatable {
    public enum Kind: String, Sendable {
        case asset
        case availability = "resource_availability"
        case gone
    }

    public let kind: Kind
    public let replayKey: String
    public let observedAt: String
    public let payload: Data

    public init(kind: Kind, replayKey: String, observedAt: String, payload: Data) {
        self.kind = kind; self.replayKey = replayKey; self.observedAt = observedAt; self.payload = payload
    }
}

extension PhotoSnapshot {
    public var name: String { Wire.snapshotKey(localIdentifier, modification: Wire.time(modificationDate)) }

    public func asset(now: Date) -> PhotoEntry {
        var payload: [String: Wire.JSON] = [
            "local_identifier": .string(localIdentifier),
            "cloud_identifier": cloudIdentifier.map(Wire.JSON.string) ?? .null,
            "media_type": .string(Wire.mediaTypeName(mediaTypeRaw)),
            "media_type_raw": .integer(Int64(mediaTypeRaw)),
            "media_subtypes": .array(Wire.mediaSubtypeNames(mediaSubtypesRaw).map(Wire.JSON.string)),
            "media_subtypes_raw": .unsigned(UInt64(mediaSubtypesRaw)),
            "creation_date": Wire.time(creationDate).map(Wire.JSON.string) ?? .null,
            "modification_date": Wire.time(modificationDate).map(Wire.JSON.string) ?? .null,
            "pixel_width": .integer(Int64(pixelWidth)),
            "pixel_height": .integer(Int64(pixelHeight)),
            "duration": mediaTypeRaw == 1 ? .null : .number(duration),
            "is_favorite": .bool(isFavorite),
            "is_hidden": .bool(isHidden),
            "source_type": .string(Wire.sourceTypeName(sourceTypeRaw)),
            "source_type_raw": .unsigned(UInt64(sourceTypeRaw)),
            "burst_identifier": burstIdentifier.map(Wire.JSON.string) ?? .null,
            "represents_burst": .bool(representsBurst),
            "resources": .array(Wire.resources(resources.map(Wire.Resource.init), resources.map { _ in .absent(nil) })),
            "location": .null,
        ]
        if let latitude, let longitude {
            payload["location"] = .object(["latitude": .number(latitude), "longitude": .number(longitude)])
        }
        let bytes = Wire.encoded(.object(payload))
        return PhotoEntry(kind: .asset, replayKey: name + ":" + Wire.sha256(bytes),
                          observedAt: Wire.time(creationDate ?? modificationDate ?? now)!, payload: bytes)
    }

    public func availability(_ files: [ResourceState], now: Date) -> PhotoEntry {
        Wire.availability(localIdentifier, modification: Wire.time(modificationDate),
                          resources: resources.map(Wire.Resource.init), files, now: now)
    }
}

extension PhotoEntry {
    public static func refusal(ofAsset payload: Data, _ refusal: Refusal, now: Date) throws -> PhotoEntry {
        let stated = try JSONDecoder().decode(Wire.Stated.self, from: payload)
        return Wire.availability(stated.local_identifier, modification: stated.modification_date, resources: stated.resources,
                                 Array(repeating: .absent(refusal), count: stated.resources.count), now: now)
    }

    public static func gone(of kind: Kind, replayKey: String, payload: Data, now: Date) -> PhotoEntry {
        let line = Data(#"{"of":"\#(kind.rawValue)","payload":"#.utf8) + payload + Data("}".utf8)
        return PhotoEntry(kind: .gone, replayKey: replayKey + ":gone", observedAt: Wire.time(now)!, payload: line)
    }
}

enum Wire {
    struct Resource: Decodable {
        let type_raw: Int64
        let uti: String
        let original_filename: String
        let size: Int64?

        init(_ resource: PhotoResource) {
            type_raw = Int64(resource.typeRaw); uti = resource.uti; original_filename = resource.originalFilename
            size = resource.size
        }
    }

    struct Stated: Decodable {
        let local_identifier: String
        let modification_date: String?
        let resources: [Resource]
    }

    static func snapshotKey(_ localIdentifier: String, modification: String?) -> String {
        "photos:\(localIdentifier):\(modification ?? "null")"
    }

    static func availability(_ localIdentifier: String, modification: String?, resources: [Resource],
                             _ files: [ResourceState], now: Date) -> PhotoEntry {
        let snapshot = snapshotKey(localIdentifier, modification: modification)
        let payload: JSON = .object([
            "snapshot_replay_key": .string(snapshot),
            "local_identifier": .string(localIdentifier),
            "modification_date": modification.map(JSON.string) ?? .null,
            "resources": .array(Self.resources(resources, files)),
        ])
        return PhotoEntry(kind: .availability, replayKey: snapshot + ":availability:" + bindingsDigest(resources, files) + ":" + time(now)!,
                          observedAt: time(now)!, payload: encoded(payload))
    }

    static func resources(_ resources: [Resource], _ files: [ResourceState]) -> [JSON] {
        precondition(resources.count == files.count, "one state per resource")
        return zip(resources, files).map { resource, state in
            var fields: [String: JSON] = [
                "type": .string(resourceTypeName(Int(resource.type_raw))),
                "type_raw": .integer(resource.type_raw),
                "uti": .string(resource.uti),
                "original_filename": .string(resource.original_filename),
                "size": resource.size.map(JSON.integer) ?? .null,
            ]
            switch state {
            case .blob(let hash, let bytes):
                fields["blob"] = .object([
                    "hash": .string(hash), "type": .string(mimeType(resource.uti)), "bytes": .unsigned(bytes),
                    "role": .string(resourceRole(Int(resource.type_raw))),
                ])
            case .absent(let refusal):
                fields["blob"] = .null
                fields["not_local"] = .bool(true)
                fields["not_local_reason"] = refusal.map { .string($0.rawValue) } ?? .null
            }
            return .object(fields)
        }
    }

    static func bindingsDigest(_ resources: [Resource], _ files: [ResourceState]) -> String {
        var tuples = Set<String>()
        for (resource, state) in zip(resources, files) {
            guard case .blob(let hash, _) = state else { continue }
            let tuple: JSON = .array([.integer(resource.type_raw), .string(resource.uti), .string(resource.original_filename), .string(hash)])
            tuples.insert(String(decoding: encoded(tuple), as: UTF8.self))
        }
        let sorted = tuples.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
        return sha256(Data(("[" + sorted.joined(separator: ",") + "]").utf8))
    }

    static func sha256(_ bytes: Data) -> String {
        "sha256:" + SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }


    static let subtypeNames: [(bit: UInt, name: String)] = [
        (1 << 0, "photoPanorama"), (1 << 1, "photoHDR"), (1 << 2, "photoScreenshot"), (1 << 3, "photoLive"),
        (1 << 4, "photoDepthEffect"), (1 << 6, "photoAnimation"), (1 << 10, "spatialMedia"), (1 << 16, "videoStreamed"),
        (1 << 17, "videoHighFrameRate"), (1 << 18, "videoTimelapse"), (1 << 19, "videoScreenRecording"),
        (1 << 21, "videoCinematic"),
    ]

    static func mediaTypeName(_ raw: Int) -> String {
        switch raw {
        case 1: "image"
        case 2: "video"
        case 3: "audio"
        default: "unknown"
        }
    }

    static func mediaSubtypeNames(_ raw: UInt) -> [String] {
        var names: [String] = []
        var remaining = raw
        for (bit, name) in subtypeNames where raw & bit != 0 {
            names.append(name)
            remaining &= ~bit
        }
        var index: UInt = 0
        while remaining != 0 {
            if remaining & 1 != 0 { names.append("bit_\(index)") }
            remaining >>= 1
            index += 1
        }
        return names.sorted()
    }

    static func sourceTypeName(_ raw: UInt) -> String {
        switch raw {
        case 1 << 0: "user_library"
        case 1 << 1: "cloud_shared"
        case 1 << 2: "itunes_synced"
        default: "unknown_\(raw)"
        }
    }

    static func resourceTypeName(_ raw: Int) -> String {
        switch raw {
        case 1: "photo"
        case 2: "video"
        case 3: "audio"
        case 4: "alternatePhoto"
        case 5: "fullSizePhoto"
        case 6: "fullSizeVideo"
        case 7: "adjustmentData"
        case 8: "adjustmentBasePhoto"
        case 9: "pairedVideo"
        case 10: "fullSizePairedVideo"
        case 11: "adjustmentBasePairedVideo"
        case 12: "adjustmentBaseVideo"
        case 19: "photoProxy"
        default: "unknown_\(raw)"
        }
    }

    static func resourceRole(_ raw: Int) -> String {
        switch raw {
        case 1, 2, 3: "original"
        case 4: "alternate"
        case 5, 6: "full_size"
        case 7: "adjustment_data"
        case 8, 11, 12: "adjustment_base"
        case 9, 10: "paired_video"
        case 19: "proxy"
        default: "unknown"
        }
    }

    static func mimeType(_ uti: String) -> String {
        UTType(uti)?.preferredMIMEType ?? "application/octet-stream"
    }


    private static let seconds: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone.gmt
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return formatter
    }()

    static func time(_ date: Date?) -> String? {
        guard let date else { return nil }
        let epoch = date.timeIntervalSince1970
        var whole = floor(epoch)
        var nanoseconds = Int64(((epoch - whole) * 1_000_000_000).rounded(.toNearestOrEven))
        if nanoseconds == 1_000_000_000 {
            whole += 1
            nanoseconds = 0
        }
        return seconds.string(from: Date(timeIntervalSince1970: whole)) + String(format: ".%09lldZ", nanoseconds)
    }

    static func date(_ text: String) -> Date? {
        guard text.hasSuffix("Z"), text.count >= 20, let whole = seconds.date(from: String(text.prefix(19))) else { return nil }
        let rest = text.dropFirst(19).dropLast()
        guard !rest.isEmpty else { return whole }
        guard rest.first == ".", rest.count > 1, rest.dropFirst().allSatisfy({ ("0"..."9").contains($0) }),
              let digits = Double("0" + rest) else { return nil }
        return whole.addingTimeInterval(digits)
    }


    enum JSON: Encodable {
        case null
        case bool(Bool)
        case integer(Int64)
        case unsigned(UInt64)
        case number(Double)
        case string(String)
        case array([JSON])
        case object([String: JSON])

        func encode(to encoder: any Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self {
            case .null: try container.encodeNil()
            case .bool(let value): try container.encode(value)
            case .integer(let value): try container.encode(value)
            case .unsigned(let value): try container.encode(value)
            case .number(let value): if value.isFinite { try container.encode(value) } else { try container.encodeNil() }
            case .string(let value): try container.encode(value)
            case .array(let value): try container.encode(value)
            case .object(let value): try container.encode(value)
            }
        }
    }

    static func encoded(_ value: JSON) -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try! encoder.encode(value)
    }
}
