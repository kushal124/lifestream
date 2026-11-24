import Foundation
import HomeLink

public struct UploadInboxItem: Sendable, Equatable {
    public let id: UUID
    public let directory: URL
    public let name: String
    public let mediaType: String
    public let sharedAt: String
}

public struct UploadInbox: Sendable {
    public let directory: URL
    let volume: Volume

    static let abandonedAfter: TimeInterval = 24 * 60 * 60
    static let payloadName = "payload"
    static let metadataName = "upload.json"
    static let hashName = "hash"
    static let stagingPrefix = ".staging-"
    static let copyPrefix = ".blob-"

    public init(directory: URL, volume: Volume) {
        self.directory = directory
        self.volume = volume
    }

    public static func shared(appGroup: String) -> UploadInbox? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup).map {
            let directory = $0.appendingPathComponent("upload-inbox", isDirectory: true)
            return UploadInbox(directory: directory, volume: Volume(directory))
        }
    }


    @discardableResult
    public func publish(file source: URL, name: String, mediaType: String, sharedAt: Date = AppClock.now) throws -> UUID {
        guard !name.isEmpty, !mediaType.isEmpty else { throw CaptureError.invalidEntry("an upload states a name and a media type") }
        try FileDurability.createDirectoryDurably(at: directory)
        try FileDurability.excludeFromBackup(directory)
        guard volume.fits(.new, bytes: Int64(clamping: try FileDurability.regularFileSize(at: source))) else { throw CaptureError.full }
        let id = UUID()
        let staging = directory.appendingPathComponent(Self.stagingPrefix + id.uuidString.lowercased(), isDirectory: true)
        try FileDurability.createPrivateDirectoryDurably(at: staging)
        do {
            try FileDurability.copyRegularFileDurably(from: source, to: staging.appendingPathComponent(Self.payloadName))
            let metadata = JSONValue.object([
                "name": .string(name), "media_type": .string(mediaType), "shared_at": .string(CaptureTime.rfc3339(sharedAt)),
            ])
            try FileDurability.writeNewRegularFileDurably(try JSONEncoder.lifestream().encode(metadata),
                                                          to: staging.appendingPathComponent(Self.metadataName))
            try FileManager.default.moveItem(at: staging, to: itemDirectory(id))
            try FileDurability.synchronizeDirectory(at: directory)
        } catch {
            try? FileDurability.removePrivateDirectoryIfPresent(at: staging)
            throw error
        }
        return id
    }


    public func pending(now: Date = AppClock.now) throws -> [UploadInboxItem] {
        guard try FileDurability.realDirectoryExists(at: directory) else { return [] }
        var items: [UploadInboxItem] = []
        for name in try FileManager.default.contentsOfDirectory(atPath: directory.path) {
            let url = directory.appendingPathComponent(name, isDirectory: true)
            if name.hasPrefix(Self.stagingPrefix) {
                let made = (try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date) ?? now
                if now.timeIntervalSince(made) > Self.abandonedAfter { try FileDurability.removePrivateDirectoryIfPresent(at: url) }
                continue
            }
            guard let id = UUID(uuidString: name), (try? FileDurability.realDirectoryExists(at: url)) == true,
                  let item = try? item(id, at: url) else { continue }
            items.append(item)
        }
        return items.sorted { ($0.sharedAt, $0.id.uuidString) < ($1.sharedAt, $1.id.uuidString) }
    }

    @discardableResult
    public func drain(into store: CaptureStore) async throws -> Int {
        var recorded = 0
        var failures: [Error] = []
        for item in try pending() {
            do {
                try await record(item, into: store)
                recorded += 1
            } catch {
                failures.append(error)
            }
        }
        if recorded == 0, let first = failures.first { throw first }
        return recorded
    }

    func record(_ item: UploadInboxItem, into store: CaptureStore) async throws {
        let payload = item.directory.appendingPathComponent(Self.payloadName)
        let hashFile = item.directory.appendingPathComponent(Self.hashName)
        let hash: String
        if let stated = try FileDurability.readRegularFileIfPresent(at: hashFile, maximumBytes: 128) {
            hash = String(decoding: stated, as: UTF8.self)
        } else {
            hash = try SHA256Digest.taggedFile(at: payload)
            try FileDurability.writeNewRegularFileDurably(Data(hash.utf8), to: hashFile)
        }
        guard SHA256Digest.isCanonicalTagged(hash) else { throw CaptureError.corruptState("upload inbox: \(item.id) states no hash") }
        if try await store.blobFile(forTaggedHash: hash) == nil, try FileDurability.entryExists(at: payload) {
            try await store.admit(bytes: Int64(clamping: try FileDurability.regularFileSize(at: payload)))
            let copy = item.directory.appendingPathComponent(Self.copyPrefix + UUID().uuidString.lowercased())
            try FileDurability.copyRegularFileDurably(from: payload, to: copy)
            let stored = try await store.storeBlob(file: OwnedMediaFile(takingOwnershipOf: copy))
            guard stored.hash == hash else { throw CaptureError.corruptState("upload inbox: \(item.id) changed after it was hashed") }
        }
        guard let blob = try await store.blobFile(forTaggedHash: hash) else {
            throw CaptureError.corruptState("upload inbox: \(item.id) has neither its payload nor its blob")
        }
        let bytes = try FileDurability.regularFileSize(at: blob)
        let draft = CaptureDraft(kind: "file", observedAt: item.sharedAt, payload: .object([
            "name": .string(item.name),
            "blob": .object(["hash": .string(hash), "bytes": .unsigned(bytes), "type": .string(item.mediaType), "role": .string("original")]),
        ]))
        try await store.appendReplayBatch(domain: .upload, drafts: [ReplayCaptureDraft(replayKey: "upload:\(item.id.uuidString.lowercased())", draft: draft)])
        try FileManager.default.removeItem(at: item.directory)
        try FileDurability.synchronizeDirectory(at: directory)
    }

    private func item(_ id: UUID, at url: URL) throws -> UploadInboxItem {
        struct Metadata: Decodable {
            let name: String
            let media_type: String
            let shared_at: String
        }
        guard let bytes = try FileDurability.readRegularFileIfPresent(at: url.appendingPathComponent(Self.metadataName), maximumBytes: 65_536),
              let metadata = try? JSONDecoder().decode(Metadata.self, from: bytes),
              !metadata.name.isEmpty, !metadata.media_type.isEmpty, CaptureTime.date(rfc3339: metadata.shared_at) != nil else {
            throw CaptureError.corruptState("upload inbox: \(id) states no readable upload.json")
        }
        return UploadInboxItem(id: id, directory: url, name: metadata.name, mediaType: metadata.media_type, sharedAt: metadata.shared_at)
    }

    private func itemDirectory(_ id: UUID) -> URL {
        directory.appendingPathComponent(id.uuidString.lowercased(), isDirectory: true)
    }
}
