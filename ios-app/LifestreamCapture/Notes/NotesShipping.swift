import Foundation
import LifestreamCaptureCore

struct RestoredFolder: Equatable {
    let id: UUID
    let name: String
    let parent: UUID?
    let sortIndex: Int
    let isDefault: Bool
    let created: Date
    let modified: Date
}

struct RestoredNote: Equatable {
    struct Attachment: Equatable {
        let id: UUID
        let filename: String
        let uti: String
        let data: Data
    }

    let id: UUID
    let folder: UUID?
    let title: String
    let created: Date
    let modified: Date
    let pinned: Bool
    let pinOrder: Int
    let deletedAt: Date?
    let rich: Data
    let attachments: [Attachment]
}

@MainActor
final class NotesShipping {
    private let capture: CaptureStore
    private var tail: Task<Void, Never>?
    private var queued = false

    init(capture: CaptureStore) {
        self.capture = capture
    }

    func changed(_ store: NotesStore) {
        guard !queued else { return }
        queued = true
        Task { try? await carry(store) }
    }

    func carry(_ store: NotesStore) async throws {
        try await serial { [self] in
            queued = false
            guard try await rebuilt() else { return }
            try await carryNow(store)
        }
    }

    func rebuildIfOwed(_ store: NotesStore, blob: @escaping (String) async throws -> Data) async throws -> Bool {
        try await serial { [self] in
            guard await capture.isRestored, !(try await rebuilt()) else { return false }
            try await rebuild(store, from: try await capture.entries(domain: .notes), blob: blob)
            try await capture.setAnchor(Self.rebuiltKey, Data([1]))
            return true
        }
    }

    private static let rebuiltKey = "notes-rebuilt"

    private func rebuilt() async throws -> Bool {
        try await capture.anchor(Self.rebuiltKey) != nil
    }

    private func serial<T: Sendable>(_ work: @escaping @MainActor () async throws -> T) async throws -> T {
        let before = tail
        let task = Task { @MainActor in
            await before?.value
            return try await work()
        }
        tail = Task { _ = await task.result }
        return try await task.value
    }

    private func carryNow(_ store: NotesStore) async throws {
        let carried = try await capture.anchors(prefix: Self.prefix)
        var drafts: [CaptureDraft] = []
        var anchors: [String: Data] = [:]
        var seen = Set<String>()
        let now = CaptureTime.rfc3339(AppClock.now)
        for folder in try store.allFolders() {
            let key = Self.prefix + "folder." + folder.id.uuidString.lowercased()
            seen.insert(key)
            let payload = Self.payload(folder)
            let digest = try Self.digest(payload)
            if carried[key] != digest {
                drafts.append(.init(kind: "folder", observedAt: now, payload: payload))
                anchors[key] = digest
            }
        }
        for note in try store.everyNote() where !(note.isVisiblyEmpty && note.deletedAt == nil) {
            let key = Self.prefix + "note." + note.id.uuidString.lowercased()
            seen.insert(key)
            let payload = try await payload(note, store: store)
            let digest = try Self.digest(payload)
            if carried[key] != digest {
                drafts.append(.init(kind: "note", observedAt: now, payload: payload))
                anchors[key] = digest
            }
        }
        var purged: [String] = []
        for key in carried.keys where !seen.contains(key) {
            let isNote = key.hasPrefix(Self.prefix + "note.")
            let id = String(key.dropFirst(Self.prefix.count + (isNote ? 5 : 7)))
            drafts.append(.init(kind: isNote ? "note" : "folder", observedAt: now,
                                payload: .object(["id": .string(id), isNote ? "purged" : "deleted": .bool(true)])))
            purged.append(key)
        }
        if !drafts.isEmpty { _ = try await capture.appendBatch(domain: .notes, drafts: drafts) }
        for (key, digest) in anchors { try await capture.setAnchor(key, digest) }
        for key in purged { try await capture.setAnchor(key, nil) }
    }

    private func rebuild(_ store: NotesStore, from entries: [CaptureEntry], blob: (String) async throws -> Data) async throws {
        var newest: [String: CaptureEntry] = [:]
        for entry in entries {
            guard case .object(let payload) = entry.payload, case .string(let id) = payload["id"] else { continue }
            newest[entry.kind + ":" + id] = entry
        }
        var folders: [RestoredFolder] = [], notes: [RestoredNote] = []
        for entry in newest.values {
            guard case .object(let p) = entry.payload else { continue }
            if case .string(let id) = p["id"] { try await capture.setAnchor(Self.prefix + entry.kind + "." + id, try Self.digest(entry.payload)) }
            if entry.kind == "folder", let folder = Self.folder(p) { folders.append(folder) }
            if entry.kind == "note", let shape = Self.noteShape(p) {
                let rich = try await blob(shape.rich)
                var attachments: [RestoredNote.Attachment] = []
                for attachment in shape.attachments {
                    attachments.append(.init(id: attachment.id, filename: attachment.filename, uti: attachment.uti, data: try await blob(attachment.hash)))
                }
                notes.append(RestoredNote(id: shape.id, folder: shape.folder, title: shape.title, created: shape.created, modified: shape.modified,
                                          pinned: shape.pinned, pinOrder: shape.pinOrder, deletedAt: shape.deletedAt, rich: rich, attachments: attachments))
            }
        }
        try store.adopt(folders: folders.sorted { $0.sortIndex < $1.sortIndex }, notes: notes)
        try await carryNow(store)
    }


    private static let prefix = "notes."

    private static func digest(_ payload: JSONValue) throws -> Data {
        Data(SHA256Digest.hex(try JSONEncoder.lifestream().encode(payload)).utf8)
    }

    private static func folderPayload(_ folder: NoteFolder) -> JSONValue {
        .object([
            "id": .string(folder.id.uuidString.lowercased()),
            "name": .string(folder.name),
            "parent": folder.parent.map { .string($0.id.uuidString.lowercased()) } ?? .null,
            "sort_index": .integer(Int64(folder.sortIndex)),
            "default": .bool(folder.isDefault),
            "created": .string(CaptureTime.rfc3339(folder.createdAt)),
            "modified": .string(CaptureTime.rfc3339(folder.modifiedAt)),
            "deleted": .bool(false),
        ])
    }

    private static func payload(_ folder: NoteFolder) -> JSONValue { folderPayload(folder) }

    private func payload(_ note: Note, store: NotesStore) async throws -> JSONValue {
        let rich = try await capture.storeBlob(note.richTextData)
        var attachments: [JSONValue] = []
        for attachment in note.attachments.sorted(by: { $0.createdAt < $1.createdAt }) {
            let data = try Data(contentsOf: store.attachmentURL(attachment))
            attachments.append(.object([
                "id": .string(attachment.id.uuidString.lowercased()),
                "filename": .string(attachment.filename),
                "uti": .string(attachment.uti),
                "blob": .object(["hash": .string(try await capture.storeBlob(data)), "bytes": .integer(Int64(data.count))]),
            ]))
        }
        return .object([
            "id": .string(note.id.uuidString.lowercased()),
            "folder": note.folder.map { .string($0.id.uuidString.lowercased()) } ?? .null,
            "title": .string(note.title),
            "text": .string(NoteSearchIndex.plainText(from: note.richTextData)),
            "created": .string(CaptureTime.rfc3339(note.createdAt)),
            "modified": .string(CaptureTime.rfc3339(note.modifiedAt)),
            "pinned": .bool(note.isPinned),
            "pin_order": .integer(Int64(note.pinOrder)),
            "deleted_at": note.deletedAt.map { .string(CaptureTime.rfc3339($0)) } ?? .null,
            "purged": .bool(false),
            "rich": .object(["hash": .string(rich), "bytes": .integer(Int64(note.richTextData.count))]),
            "attachments": .array(attachments),
        ])
    }


    private struct NoteShape {
        let id: UUID, folder: UUID?, title: String, created: Date, modified: Date
        let pinned: Bool, pinOrder: Int, deletedAt: Date?, rich: String
        let attachments: [(id: UUID, filename: String, uti: String, hash: String)]
    }

    private static func folder(_ p: [String: JSONValue]) -> RestoredFolder? {
        guard let id = uuid(p["id"]), case .string(let name) = p["name"], let created = date(p["created"]), let modified = date(p["modified"]),
              case .bool(let isDefault) = p["default"] else { return nil }
        return RestoredFolder(id: id, name: name, parent: uuid(p["parent"]), sortIndex: integer(p["sort_index"]), isDefault: isDefault,
                              created: created, modified: modified)
    }

    private static func noteShape(_ p: [String: JSONValue]) -> NoteShape? {
        guard let id = uuid(p["id"]), case .string(let title) = p["title"], let created = date(p["created"]), let modified = date(p["modified"]),
              case .bool(let pinned) = p["pinned"], case .object(let rich) = p["rich"], case .string(let richHash) = rich["hash"],
              case .array(let attached) = p["attachments"] else { return nil }
        let attachments = attached.compactMap { value -> (UUID, String, String, String)? in
            guard case .object(let a) = value, let id = uuid(a["id"]), case .string(let filename) = a["filename"], case .string(let uti) = a["uti"],
                  case .object(let blob) = a["blob"], case .string(let hash) = blob["hash"] else { return nil }
            return (id, filename, uti, hash)
        }
        return NoteShape(id: id, folder: uuid(p["folder"]), title: title, created: created, modified: modified, pinned: pinned,
                         pinOrder: integer(p["pin_order"]), deletedAt: date(p["deleted_at"]), rich: richHash,
                         attachments: attachments.map { (id: $0.0, filename: $0.1, uti: $0.2, hash: $0.3) })
    }

    private static func uuid(_ value: JSONValue?) -> UUID? {
        if case .string(let text) = value { return UUID(uuidString: text) }
        return nil
    }

    private static func date(_ value: JSONValue?) -> Date? {
        if case .string(let text) = value { return CaptureTime.date(rfc3339: text) }
        return nil
    }

    private static func integer(_ value: JSONValue?) -> Int {
        switch value {
        case .integer(let number): Int(number)
        case .number(let number): Int(number)
        default: 0
        }
    }
}
