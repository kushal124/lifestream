import Foundation

public enum ContactsAuthorization: String, Codable, Sendable {
    case authorized, limited, denied, restricted
    case notDetermined = "not_determined"

    public var canRead: Bool { self == .authorized || self == .limited }
}

public struct ContactCard: Sendable, Equatable {
    public static let serializer = "CNContactVCardSerialization"

    public let id: String
    public let card: String
    public let photo: Data?
    public let photoHash: String?

    public init(id: String, card: Data, photo: Data?) throws {
        guard let text = String(data: card, encoding: .utf8) else { throw CaptureError.invalidEntry("the card of contact \(id) is not UTF-8") }
        self.id = id
        self.card = text
        self.photo = photo?.isEmpty == false ? photo : nil
        photoHash = self.photo.map(SHA256Digest.tagged)
    }

    public var mark: ContactMark {
        ContactMark(card: ContactMark.digest(card: card), photo: photoHash)
    }

    public var bytes: Int { card.utf8.count + (photo?.count ?? 0) }

    func payload() -> JSONValue {
        var payload: [String: JSONValue] = ["id": .string(id), "card": .string(card), "serializer": .string(Self.serializer)]
        if let photo, let photoHash {
            payload["photo"] = .object(["hash": .string(photoHash), "bytes": .integer(Int64(photo.count)),
                                        "media_type": .string(Self.mediaType(photo))])
        }
        return .object(payload)
    }

    static func mediaType(_ bytes: Data) -> String {
        let head = [UInt8](bytes.prefix(12))
        if head.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
        if head.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return "image/png" }
        if head.count == 12, head[4..<8].elementsEqual("ftyp".utf8) {
            switch String(decoding: head[8..<12], as: UTF8.self) {
            case "heic", "heix": return "image/heic"
            case "mif1": return "image/heif"
            default: break
            }
        }
        return "application/octet-stream"
    }
}

public struct ContactMark: Sendable, Equatable, Codable {
    public var card: String?
    public var photo: String?

    static func digest(card: String) -> String {
        var kept = Data()
        for line in card.utf8.split(separator: 0x0A, omittingEmptySubsequences: false) where !line.starts(with: "PRODID:".utf8) {
            kept.append(contentsOf: line)
            kept.append(0x0A)
        }
        return SHA256Digest.tagged(kept)
    }
}

public protocol ContactReader: Sendable {
    func read() async throws -> ContactsRead
    func cards(_ ids: [String]) async throws -> [ContactCard]
}

public struct ContactsRead: Sendable, Equatable {
    public var marks: [String: ContactMark]
    public var bytes: [String: Int]
    public var authorization: ContactsAuthorization

    public init(marks: [String: ContactMark], bytes: [String: Int], authorization: ContactsAuthorization) {
        self.marks = marks
        self.bytes = bytes
        self.authorization = authorization
    }
}

public struct ContactsTable: Sendable, Equatable, Codable {
    public var sequence: UInt64 = 0
    public var seeded = false
    public var authorization: ContactsAuthorization?
    public var whole = false
    public var lastRead: String?
    public var pass: String?
    public var contacts: [String: ContactMark] = [:]

    init(seed: [String]?) {
        guard let seed else { return }
        seeded = true
        whole = true
        for id in seed { contacts[id] = ContactMark() }
    }

    mutating func include(_ entry: CaptureEntry) {
        sequence = entry.sequence
        guard case .object(let payload) = entry.payload else { return }
        switch entry.kind {
        case "access":
            guard case .string(let value)? = payload["authorization"], let stated = ContactsAuthorization(rawValue: value) else { return }
            if authorization != nil && authorization != stated { whole = false }
            authorization = stated
        case "card":
            guard case .string(let id)? = payload["id"], case .string(let card)? = payload["card"] else { return }
            var photo: String?
            if case .object(let named)? = payload["photo"], case .string(let hash)? = named["hash"] { photo = hash }
            contacts[id] = ContactMark(card: ContactMark.digest(card: card), photo: photo)
        case "gone":
            guard case .string(let id)? = payload["id"] else { return }
            contacts[id] = nil
        default:
            break
        }
    }

    public var stated: Int { contacts.values.filter { $0.card != nil }.count }

    func under(_ pass: String?) -> ContactsTable {
        guard pass != self.pass else { return self }
        var table = self
        table.pass = pass
        guard self.pass != nil else { return table }
        for id in table.contacts.keys { table.contacts[id] = ContactMark() }
        table.whole = true
        table.lastRead = nil
        return table
    }
}

public struct ContactsLog: Sendable {
    static let tableKey = "contacts.table"
    static let seedKey = "contacts.seed"
    static let batchBytes = 4_000_000

    static func batches(_ ids: [String], bytes: [String: Int]) -> [[String]] {
        var batches: [[String]] = []
        var held = 0
        for id in ids {
            let size = bytes[id] ?? 0
            if batches.isEmpty || held + size > batchBytes {
                batches.append([])
                held = 0
            }
            batches[batches.count - 1].append(id)
            held += size
        }
        return batches
    }

    public let store: CaptureStore

    public init(store: CaptureStore) { self.store = store }

    public func table() async throws -> ContactsTable {
        let sequence = try await store.capturedThrough()[.contacts] ?? 0
        let seed = try await store.anchor(Self.seedKey)
        let pass = try await store.answeredPass()
        let kept = try await store.anchor(Self.tableKey).flatMap { try? JSONDecoder.lifestream().decode(ContactsTable.self, from: $0) }
        if let kept, kept.sequence == sequence, kept.seeded == (seed != nil) { return kept.under(pass) }
        let ids = try seed.map { try JSONDecoder.lifestream().decode([String].self, from: $0) }
        var folded = try await store.foldEntries(domain: .contacts, initial: ContactsTable(seed: ids)) { $0.include($1) }
        folded.pass = kept?.pass
        return folded.under(pass)
    }

    @discardableResult
    public func pass(_ table: ContactsTable, authorization: ContactsAuthorization, reader: (any ContactReader)?,
                     at date: Date) async throws -> ContactsTable {
        var table = table
        let observedAt = CaptureTime.rfc3339(date)
        func write(_ drafts: [CaptureDraft]) async throws {
            for entry in try await store.appendBatch(domain: .contacts, drafts: drafts) { table.include(entry) }
        }
        func state(_ access: ContactsAuthorization) async throws {
            guard table.authorization != access else { return }
            try await write([CaptureDraft(kind: "access", observedAt: observedAt, payload: .object(["authorization": .string(access.rawValue)]))])
        }
        do {
            try await state(authorization)
            if let reader {
                let read = try await reader.read()
                try await state(read.authorization)
                let whole = authorization == .authorized && read.authorization == .authorized
                let changed = read.marks.filter { table.contacts[$0.key] != $0.value }.keys.sorted()
                for asked in Self.batches(changed, bytes: read.bytes) {
                    let wanted = Set(asked)
                    var drafts: [CaptureDraft] = []
                    var photos: [String: Data] = [:]
                    for card in try await reader.cards(asked) where wanted.contains(card.id) && table.contacts[card.id] != card.mark {
                        if let photo = card.photo, let hash = card.photoHash { photos[hash] = photo }
                        drafts.append(CaptureDraft(kind: "card", observedAt: observedAt, payload: card.payload()))
                    }
                    for (hash, photo) in photos.sorted(by: { $0.key < $1.key }) { _ = try await store.storeBlob(photo, tagged: hash) }
                    try await write(drafts)
                }
                if whole && table.whole {
                    let gone = table.contacts.keys.filter { read.marks[$0] == nil }.sorted()
                    try await write(gone.map { CaptureDraft(kind: "gone", observedAt: observedAt, payload: .object(["id": .string($0)])) })
                }
                table.whole = whole
                table.lastRead = observedAt
            }
        } catch {
            try? await save(table)
            throw error
        }
        try await save(table)
        return table
    }

    private func save(_ table: ContactsTable) async throws {
        let encoded = try JSONEncoder.lifestream().encode(table)
        guard try await store.anchor(Self.tableKey) != encoded else { return }
        try await store.setAnchor(Self.tableKey, encoded)
    }

    public func photosKept() async throws -> (count: Int, bytes: UInt64) {
        let named = try await store.namedBlobs([(.contacts, 0)])
        return try await store.blobInventory().filter { named.contains($0.hash) }
            .reduce((count: 0, bytes: UInt64(0))) { ($0.count + 1, $0.bytes + $1.bytes) }
    }
}


extension CaptureStore {
    func seedContacts(_ ids: [String]) throws {
        try database.run("INSERT OR REPLACE INTO anchor (key, value) VALUES (?, ?)",
                         .text(ContactsLog.seedKey), .blob(try JSONEncoder.lifestream().encode(ids.sorted())))
    }

    func clearImportedContactPhotos(through: UInt64) throws {
        let floor = try Self.fact(Fact.contactsClearedThrough, in: database).flatMap(UInt64.init) ?? 0
        guard through > floor, through <= (try lastSequence(.contacts)) else { return }
        var cleared = Set<String>()
        var kept = Set<String>()
        let marker = Data("\"hash\":\"sha256:".utf8)
        for domain in CaptureDomain.allCases {
            try database.query("SELECT sequence, line FROM \(domain.table) WHERE instr(line, ?) > 0", .blob(marker)) { row in
                let hashes = try Self.blobHashes(in: row.blob(1))
                if domain == .contacts && UInt64(row.integer(0)) <= through { cleared.formUnion(hashes) } else { kept.formUnion(hashes) }
            }
        }
        for hash in cleared.subtracting(kept).sorted() {
            try FileDurability.removeRegularFileIfPresent(at: blobsDirectory.appendingPathComponent(String(hash.dropFirst(7))))
        }
        try FileDurability.synchronizeDirectory(at: blobsDirectory)
        try database.write { try Self.setFact(Fact.contactsClearedThrough, String(through), in: database) }
    }
}
