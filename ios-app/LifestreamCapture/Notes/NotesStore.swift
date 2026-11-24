import Foundation
import LifestreamCaptureCore
import SwiftData
import UIKit

@MainActor
final class NotesStore {
    let container: ModelContainer
    let attachments: AttachmentFileStore
    let retention: TimeInterval
    private let persist: (ModelContext) throws -> Void
    var saved: () -> Void = {}

    var context: ModelContext { container.mainContext }

    init(
        container: ModelContainer,
        attachments: AttachmentFileStore,
        retention: TimeInterval = NotesRetention.deletedNoteLifetime,
        persist: @escaping (ModelContext) throws -> Void = { try $0.save() }
    ) {
        self.container = container
        self.attachments = attachments
        self.retention = retention
        self.persist = persist
        container.mainContext.autosaveEnabled = false
    }

    static func defaultRoot() throws -> URL {
        let support = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return support.appendingPathComponent("LifestreamCapture/notes", isDirectory: true)
    }

    static func open(root: URL) throws -> NotesStore {
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        } catch {
            throw NotesError.storeUnavailable(
                "Notes could not create its store directory: \(error.localizedDescription)"
            )
        }
        let storeURL = root.appendingPathComponent("Notes.store", isDirectory: false)
        let attachments = AttachmentFileStore(
            root: root.appendingPathComponent("attachments", isDirectory: true)
        )
        do {
            try attachments.prepare()
            let schema = NotesSchema.current
            let configuration = ModelConfiguration(
                "Notes",
                schema: schema,
                url: storeURL,
                allowsSave: true
            )
            let container = try ModelContainer(
                for: schema,
                migrationPlan: NotesMigrationPlan.self,
                configurations: configuration
            )
            let store = NotesStore(container: container, attachments: attachments)
            _ = try store.ensureDefaultFolder()
            return store
        } catch let error as NotesError {
            throw error
        } catch {
            throw NotesError.storeUnavailable(
                "Notes store is unreadable and was left unchanged: \(error.localizedDescription)"
            )
        }
    }

    static func inMemory(attachmentsRoot: URL) throws -> NotesStore {
        let schema = NotesSchema.current
        let configuration = ModelConfiguration(
            schema: schema,
            isStoredInMemoryOnly: true
        )
        let container = try ModelContainer(for: schema, configurations: configuration)
        let attachments = AttachmentFileStore(root: attachmentsRoot)
        try attachments.prepare()
        let store = NotesStore(container: container, attachments: attachments)
        _ = try store.ensureDefaultFolder()
        return store
    }

    @discardableResult
    func ensureDefaultFolder(now: Date = AppClock.now) throws -> NoteFolder {
        if let existing = try defaultFolderIfPresent() {
            return existing
        }
        let folder = NoteFolder(
            name: "Notes",
            createdAt: now,
            modifiedAt: now,
            sortIndex: 0,
            isDefault: true
        )
        context.insert(folder)
        try save()
        return folder
    }

    func defaultFolder() throws -> NoteFolder {
        if let folder = try defaultFolderIfPresent() {
            return folder
        }
        return try ensureDefaultFolder()
    }

    func allFolders() throws -> [NoteFolder] {
        let descriptor = FetchDescriptor<NoteFolder>(
            sortBy: [SortDescriptor(\.sortIndex), SortDescriptor(\.name)]
        )
        return try context.fetch(descriptor)
    }

    func folder(id: UUID) throws -> NoteFolder {
        let descriptor = FetchDescriptor<NoteFolder>(
            predicate: #Predicate { $0.id == id }
        )
        guard let folder = try context.fetch(descriptor).first else {
            throw NotesError.folderNotFound
        }
        return folder
    }

    func createFolder(name: String, parent: NoteFolder?, now: Date = AppClock.now) throws -> NoteFolder {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw NotesError.invalidFolderName }
        let nextIndex = ((try allFolders().map(\.sortIndex).max()) ?? -1) + 1
        let folder = NoteFolder(
            name: trimmed,
            createdAt: now,
            modifiedAt: now,
            sortIndex: nextIndex,
            parent: parent
        )
        context.insert(folder)
        try save()
        return folder
    }

    func renameFolder(_ folder: NoteFolder, to name: String, now: Date = AppClock.now) throws {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw NotesError.invalidFolderName }
        folder.name = trimmed
        folder.modifiedAt = now
        try save()
    }

    func moveFolder(_ folder: NoteFolder, to parent: NoteFolder?, now: Date = AppClock.now) throws {
        if let parent {
            if try parent.id == folder.id || isDescendant(parent, of: folder) {
                throw NotesError.invalidFolderMove
            }
        }
        folder.parent = parent
        folder.modifiedAt = now
        try save()
    }

    func deleteFolder(_ folder: NoteFolder, now: Date = AppClock.now) throws {
        guard !folder.isDefault else { throw NotesError.defaultFolderProtected }
        let descendants = try descendants(of: folder).reversed()
        let containedNotes = try notes(inSubtreeOf: folder)
        for note in containedNotes where note.deletedAt == nil {
            try softDelete(note, now: now, saveAfter: false)
        }
        for child in descendants {
            context.delete(child)
        }
        context.delete(folder)
        try save()
    }

    func notes(in folder: NoteFolder?) throws -> [Note] {
        try context.fetch(activeNotesDescriptor(in: folder))
    }

    private func activeNotesDescriptor(in folder: NoteFolder?) -> FetchDescriptor<Note> {
        if let folder {
            let folderID = folder.id
            return FetchDescriptor(predicate: #Predicate {
                $0.deletedAt == nil && $0.folder?.id == folderID
            })
        }
        return FetchDescriptor(predicate: #Predicate { $0.deletedAt == nil })
    }

    func recentNotes(limit: Int) throws -> [Note] {
        var descriptor = FetchDescriptor<Note>(
            predicate: #Predicate { $0.deletedAt == nil },
            sortBy: [SortDescriptor(\.modifiedAt, order: .reverse)]
        )
        descriptor.fetchLimit = limit
        return try context.fetch(descriptor)
    }

    func everyNote() throws -> [Note] {
        try context.fetch(FetchDescriptor<Note>())
    }

    func adopt(folders: [RestoredFolder], notes: [RestoredNote]) throws {
        var byID = Dictionary(try allFolders().map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for folder in folders where byID[folder.id] == nil {
            if folder.isDefault, let opened = try defaultFolderIfPresent() {
                byID[opened.id] = nil
                opened.id = folder.id
                opened.name = folder.name
                byID[folder.id] = opened
                continue
            }
            let made = NoteFolder(id: folder.id, name: folder.name, createdAt: folder.created, modifiedAt: folder.modified,
                                  sortIndex: folder.sortIndex, isDefault: folder.isDefault)
            context.insert(made)
            byID[folder.id] = made
        }
        for folder in folders { byID[folder.id]?.parent = folder.parent.flatMap { byID[$0] } }
        let held = Set(try everyNote().map(\.id))
        for restored in notes where !held.contains(restored.id) {
            let plain = NoteSearchIndex.plainText(from: restored.rich)
            let note = Note(id: restored.id, title: restored.title, snippet: RichTextCodec.inferredSnippet(from: plain),
                            searchText: NoteSearchIndex.make(title: restored.title, plainText: plain, attachmentNames: restored.attachments.map(\.filename)),
                            createdAt: restored.created, modifiedAt: restored.modified, isPinned: restored.pinned, pinOrder: restored.pinOrder,
                            deletedAt: restored.deletedAt, richTextData: restored.rich, folder: restored.folder.flatMap { byID[$0] })
            context.insert(note)
            for attachment in restored.attachments {
                let path = try attachments.store(noteID: restored.id, attachmentID: attachment.id, filename: attachment.filename, data: attachment.data)
                context.insert(NoteAttachment(id: attachment.id, filename: attachment.filename, uti: attachment.uti,
                                              byteCount: attachment.data.count, relativePath: path, createdAt: restored.modified, note: note))
            }
        }
        try save()
    }

    func deletedNotes() throws -> [Note] {
        let descriptor = FetchDescriptor<Note>(
            predicate: #Predicate { $0.deletedAt != nil },
            sortBy: [SortDescriptor(\.deletedAt, order: .reverse)]
        )
        return try context.fetch(descriptor)
    }

    func note(id: UUID) throws -> Note {
        let descriptor = FetchDescriptor<Note>(
            predicate: #Predicate { $0.id == id }
        )
        guard let note = try context.fetch(descriptor).first else {
            throw NotesError.noteNotFound
        }
        return note
    }

    func createNote(in folder: NoteFolder, now: Date = AppClock.now) throws -> Note {
        let attributed = NSAttributedString(string: "", attributes: NoteFormatting.attributes(for: .title))
        let note = Note(
            createdAt: now,
            modifiedAt: now,
            richTextData: try RichTextCodec.encode(attributed),
            folder: folder
        )
        context.insert(note)
        try save()
        return note
    }

    func updateContent(
        _ note: Note,
        attributed: NSAttributedString,
        now: Date = AppClock.now
    ) throws {
        let plain = RichTextCodec.plainText(from: attributed)
        note.richTextData = try RichTextCodec.encode(attributed)
        note.title = RichTextCodec.inferredTitle(from: plain)
        note.snippet = RichTextCodec.inferredSnippet(from: plain)
        note.searchText = NoteSearchIndex.make(
            title: note.title,
            plainText: plain,
            attachmentNames: note.attachments.map(\.filename)
        )
        note.modifiedAt = now
        try save()
    }

    func pin(_ note: Note) throws {
        guard note.deletedAt == nil else { return }
        var descriptor = FetchDescriptor<Note>(
            predicate: #Predicate { $0.deletedAt == nil && $0.isPinned },
            sortBy: [SortDescriptor(\.pinOrder, order: .reverse)])
        descriptor.fetchLimit = 1
        let current = try context.fetch(descriptor).first?.pinOrder ?? 0
        note.isPinned = true
        note.pinOrder = current + 1
        try save()
    }

    func unpin(_ note: Note) throws {
        note.isPinned = false
        note.pinOrder = 0
        try save()
    }

    func moveNote(_ note: Note, to folder: NoteFolder, now: Date = AppClock.now) throws {
        note.folder = folder
        if note.deletedAt != nil {
            note.deletedAt = nil
            note.isPinned = false
            note.pinOrder = 0
        }
        note.modifiedAt = now
        try save()
    }

    func softDelete(_ note: Note, now: Date = AppClock.now) throws {
        try softDelete(note, now: now, saveAfter: true)
    }

    func recover(_ note: Note, now: Date = AppClock.now) throws {
        note.deletedAt = nil
        if note.folder == nil {
            note.folder = try defaultFolder()
        }
        note.modifiedAt = now
        try save()
    }

    func permanentlyDelete(_ note: Note) throws {
        let paths = note.attachments.map(\.relativePath)
        context.delete(note)
        try save()
        for path in paths {
            try attachments.remove(relativePath: path)
        }
    }

    @discardableResult
    func deleteEmptyNoteIfNeeded(_ note: Note) throws -> Bool {
        guard note.deletedAt == nil, note.isVisiblyEmpty else { return false }
        context.delete(note)
        try save()
        return true
    }

    func search(_ query: String) throws -> [Note] {
        let notes = try notes(in: nil)
        return notes.filter { NoteSearchIndex.matches(query: query, searchText: $0.searchText) }
            .sorted { $0.modifiedAt > $1.modifiedAt }
    }

    @discardableResult
    func purgeExpiredDeletedNotes(now: Date = AppClock.now) throws -> Int {
        let expired = try deletedNotes().filter { note in
            guard let deletedAt = note.deletedAt else { return false }
            return now.timeIntervalSince(deletedAt) >= retention
        }
        for note in expired {
            try permanentlyDelete(note)
        }
        return expired.count
    }

    func addAttachment(
        to note: Note,
        filename: String,
        uti: String?,
        data: Data,
        now: Date = AppClock.now
    ) throws -> NoteAttachment {
        let attachmentID = UUID()
        let relativePath = try attachments.store(
            noteID: note.id,
            attachmentID: attachmentID,
            filename: filename,
            data: data
        )
        return try recordAttachment(
            id: attachmentID, noteID: note.id, filename: filename, uti: uti, byteCount: data.count,
            relativePath: relativePath, now: now)
    }

    func importAttachment(to noteID: UUID, filename: String, uti: String?, data: Data) async throws
        -> NoteAttachment
    {
        let attachmentID = UUID()
        let files = attachments
        let path = try await Task.detached(priority: .userInitiated) {
            try files.store(noteID: noteID, attachmentID: attachmentID, filename: filename, data: data)
        }.value
        return try recordAttachment(
            id: attachmentID, noteID: noteID, filename: filename, uti: uti, byteCount: data.count,
            relativePath: path, now: AppClock.now)
    }

    func importAttachment(to noteID: UUID, filename: String, uti: String?, source: URL) async throws -> NoteAttachment {
        let attachmentID = UUID()
        let files = attachments
        let stored = try await Task.detached(priority: .userInitiated) {
            try files.store(noteID: noteID, attachmentID: attachmentID, filename: filename, source: source)
        }.value
        return try recordAttachment(id: attachmentID, noteID: noteID, filename: filename, uti: uti,
                                    byteCount: stored.bytes, relativePath: stored.path, now: AppClock.now)
    }

    private func recordAttachment(
        id: UUID, noteID: UUID, filename: String, uti: String?, byteCount: Int, relativePath: String,
        now: Date
    ) throws -> NoteAttachment {
        do {
            let note = try note(id: noteID)
            guard !note.isDeleted else { throw NotesError.noteNotFound }
            let record = NoteAttachment(
                id: id,
                filename: AttachmentFileStore.sanitizedFilename(filename),
                uti: AttachmentFileStore.inferredUTI(filename: filename, fallback: uti),
                byteCount: byteCount,
                relativePath: relativePath,
                createdAt: now,
                note: note
            )
            context.insert(record)
            note.modifiedAt = now
            refreshSearchText(for: note)
            try save()
            return record
        } catch {
            let saveError = error
            do {
                try attachments.remove(relativePath: relativePath)
            } catch {
                throw NotesError.attachmentIO(
                    "\(saveError.localizedDescription) Attachment cleanup will retry when Notes is reopened: \(error.localizedDescription)"
                )
            }
            throw saveError
        }
    }

    func removeAttachment(_ attachment: NoteAttachment, now: Date = AppClock.now) throws {
        let relativePath = attachment.relativePath
        let note = attachment.note
        context.delete(attachment)
        if let note {
            note.modifiedAt = now
            refreshSearchText(for: note)
        }
        try save()
        try attachments.remove(relativePath: relativePath)
    }

    func attachmentURL(_ attachment: NoteAttachment) -> URL {
        attachments.url(for: attachment.relativePath)
    }

    @discardableResult
    func cleanupOrphanedAttachmentFiles() throws -> Int {
        let descriptor = FetchDescriptor<NoteAttachment>()
        let referenced = Set(try context.fetch(descriptor).map(\.relativePath))
        return try attachments.cleanupOrphans(referencedPaths: referenced)
    }

    func folderNoteCount(_ folder: NoteFolder) -> Int {
        (try? context.fetchCount(activeNotesDescriptor(in: folder))) ?? 0
    }

    func allNotesCount() throws -> Int {
        try context.fetchCount(activeNotesDescriptor(in: nil))
    }

    func deletedNotesCount() throws -> Int {
        try context.fetchCount(FetchDescriptor<Note>(predicate: #Predicate { $0.deletedAt != nil }))
    }

    func sortedNotes(_ notes: [Note], sort: NoteSort) -> [Note] {
        let pinned = notes.filter(\.isPinned).sorted { lhs, rhs in
            if lhs.pinOrder != rhs.pinOrder { return lhs.pinOrder > rhs.pinOrder }
            return lhs.modifiedAt > rhs.modifiedAt
        }
        let regular = notes.filter { !$0.isPinned }
        return pinned + Self.sortRegular(regular, by: sort)
    }

    static func sortRegular(_ notes: [Note], by sort: NoteSort) -> [Note] {
        switch sort {
        case .dateEdited:
            notes.sorted { $0.modifiedAt > $1.modifiedAt }
        case .dateCreated:
            notes.sorted { $0.createdAt > $1.createdAt }
        case .title:
            notes.sorted {
                $0.displayTitle.localizedCaseInsensitiveCompare($1.displayTitle) == .orderedAscending
            }
        }
    }

    private func defaultFolderIfPresent() throws -> NoteFolder? {
        let descriptor = FetchDescriptor<NoteFolder>(
            predicate: #Predicate { $0.isDefault }
        )
        return try context.fetch(descriptor).first
    }

    private func softDelete(_ note: Note, now: Date, saveAfter: Bool) throws {
        note.deletedAt = now
        note.isPinned = false
        note.pinOrder = 0
        note.modifiedAt = now
        if saveAfter {
            try save()
        }
    }

    private func refreshSearchText(for note: Note) {
        let plain = NoteSearchIndex.plainText(from: note.richTextData)
        note.searchText = NoteSearchIndex.make(
            title: note.title,
            plainText: plain,
            attachmentNames: note.attachments.map(\.filename)
        )
    }

    private func notes(inSubtreeOf folder: NoteFolder) throws -> [Note] {
        let tree = [folder] + (try descendants(of: folder))
        let ids = Set(tree.map(\.id))
        let descriptor = FetchDescriptor<Note>()
        return try context.fetch(descriptor).filter { note in
            guard let folderID = note.folder?.id else { return false }
            return ids.contains(folderID)
        }
    }

    private func descendants(of folder: NoteFolder) throws -> [NoteFolder] {
        let folders = try allFolders()
        let children = Dictionary(grouping: folders, by: { $0.parent?.id })
        var result: [NoteFolder] = []
        var queue = children[folder.id] ?? []
        var visited: Set<UUID> = [folder.id]
        var index = 0
        while index < queue.count {
            let next = queue[index]
            index += 1
            guard visited.insert(next.id).inserted else { continue }
            result.append(next)
            queue.append(contentsOf: children[next.id] ?? [])
        }
        return result
    }

    private func isDescendant(_ candidate: NoteFolder, of ancestor: NoteFolder) throws -> Bool {
        try descendants(of: ancestor).contains { $0.id == candidate.id }
    }

    private func save() throws {
        do {
            try persist(context)
            saved()
        } catch {
            context.rollback()
            throw NotesError.storeUnavailable(
                "Notes could not save: \(error.localizedDescription)"
            )
        }
    }
}
