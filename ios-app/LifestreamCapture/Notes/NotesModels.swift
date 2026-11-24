import Foundation
import LifestreamCaptureCore
import SwiftData

enum NotesSchemaV1: VersionedSchema {
    static let versionIdentifier = Schema.Version(1, 0, 0)

    static var models: [any PersistentModel.Type] {
        [NoteFolder.self, Note.self, NoteAttachment.self]
    }
}

enum NotesMigrationPlan: SchemaMigrationPlan {
    static var schemas: [any VersionedSchema.Type] { [NotesSchemaV1.self] }
    static var stages: [MigrationStage] { [] }
}

@Model
final class NoteFolder {
    @Attribute(.unique) var id: UUID
    var name: String
    var createdAt: Date
    var modifiedAt: Date
    var sortIndex: Int
    var isDefault: Bool
    var parent: NoteFolder?

    @Relationship(deleteRule: .nullify, inverse: \NoteFolder.parent)
    var children: [NoteFolder] = []

    @Relationship(deleteRule: .nullify, inverse: \Note.folder)
    var notes: [Note] = []

    init(
        id: UUID = UUID(),
        name: String,
        createdAt: Date = AppClock.now,
        modifiedAt: Date = AppClock.now,
        sortIndex: Int = 0,
        isDefault: Bool = false,
        parent: NoteFolder? = nil
    ) {
        self.id = id
        self.name = name
        self.createdAt = createdAt
        self.modifiedAt = modifiedAt
        self.sortIndex = sortIndex
        self.isDefault = isDefault
        self.parent = parent
    }
}

@Model
final class Note {
    @Attribute(.unique) var id: UUID
    var title: String
    var snippet: String
    var searchText: String
    var createdAt: Date
    var modifiedAt: Date
    var isPinned: Bool
    var pinOrder: Int
    var deletedAt: Date?
    var richTextData: Data
    var folder: NoteFolder?

    @Relationship(deleteRule: .cascade, inverse: \NoteAttachment.note)
    var attachments: [NoteAttachment] = []

    init(
        id: UUID = UUID(),
        title: String = "",
        snippet: String = "",
        searchText: String = "",
        createdAt: Date = AppClock.now,
        modifiedAt: Date = AppClock.now,
        isPinned: Bool = false,
        pinOrder: Int = 0,
        deletedAt: Date? = nil,
        richTextData: Data = Data(),
        folder: NoteFolder? = nil
    ) {
        self.id = id
        self.title = title
        self.snippet = snippet
        self.searchText = searchText
        self.createdAt = createdAt
        self.modifiedAt = modifiedAt
        self.isPinned = isPinned
        self.pinOrder = pinOrder
        self.deletedAt = deletedAt
        self.richTextData = richTextData
        self.folder = folder
    }

    var displayTitle: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "New note" : trimmed
    }

    var isDeleted: Bool { deletedAt != nil }

    var isVisiblyEmpty: Bool {
        attachments.isEmpty
            && title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && snippet.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && NoteSearchIndex.plainText(from: richTextData)
                .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

@Model
final class NoteAttachment {
    @Attribute(.unique) var id: UUID
    var filename: String
    var uti: String
    var byteCount: Int
    var relativePath: String
    var createdAt: Date
    var note: Note?

    init(
        id: UUID = UUID(),
        filename: String,
        uti: String,
        byteCount: Int,
        relativePath: String,
        createdAt: Date = AppClock.now,
        note: Note? = nil
    ) {
        self.id = id
        self.filename = filename
        self.uti = uti
        self.byteCount = byteCount
        self.relativePath = relativePath
        self.createdAt = createdAt
        self.note = note
    }
}

enum NotesSchema {
    static var current: Schema {
        Schema(versionedSchema: NotesSchemaV1.self)
    }
}
