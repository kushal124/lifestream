import XCTest
import UIKit

@testable import Lifestream

@MainActor
final class NotesStoreTests: XCTestCase {
    func testAsyncAttachmentImportPersistsBytesAndMetadata() async throws {
        let store = try makeStore()
        let note = try store.createNote(in: store.defaultFolder())
        let data = Data("synthetic file".utf8)
        let attachment = try await store.importAttachment(
            to: note.id, filename: "example.txt", uti: "public.plain-text", data: data)
        XCTAssertEqual(try Data(contentsOf: store.attachmentURL(attachment)), data)
        XCTAssertEqual(try store.note(id: note.id).attachments.map(\.id), [attachment.id])
        XCTAssertEqual(try store.search("example.txt").map(\.id), [note.id])
    }

    func testFailedAttachmentDeletionPreservesBytesAndMetadata() throws {
        let store = try makeStore()
        let note = try store.createNote(in: store.defaultFolder())
        let file = try store.addAttachment(to: note, filename: "keep.txt", uti: nil, data: Data("keep".utf8))
        let url = store.attachmentURL(file)
        let failing = failingSaves(in: store)

        XCTAssertThrowsError(try failing.removeAttachment(file))
        XCTAssertEqual(try Data(contentsOf: url), Data("keep".utf8))
        XCTAssertEqual(try store.note(id: note.id).attachments.count, 1)

        XCTAssertThrowsError(try failing.permanentlyDelete(store.note(id: note.id)))
        XCTAssertEqual(try Data(contentsOf: url), Data("keep".utf8))
        XCTAssertEqual(try store.note(id: note.id).attachments.count, 1)
    }

    func testFailedAttachmentAdditionRemovesOnlyItsNewFile() throws {
        let store = try makeStore()
        let note = try store.createNote(in: store.defaultFolder())
        _ = try store.addAttachment(to: note, filename: "keep.txt", uti: nil, data: Data("keep".utf8))
        let originalPaths = try store.attachments.existingRelativePaths()
        XCTAssertThrowsError(
            try failingSaves(in: store).addAttachment(
                to: note, filename: "new.txt", uti: nil, data: Data("new".utf8)))
        XCTAssertEqual(try store.attachments.existingRelativePaths(), originalPaths)
        XCTAssertEqual(try store.note(id: note.id).attachments.count, 1)
    }

    func testFailedFolderDeleteRollsBackTheEntireTree() throws {
        let store = try makeStore()
        let parent = try store.createFolder(name: "Parent", parent: nil)
        let child = try store.createFolder(name: "Child", parent: parent)
        let note = try store.createNote(in: child)
        try store.updateContent(note, attributed: attributed("Keep this note"))
        XCTAssertThrowsError(try failingSaves(in: store).deleteFolder(parent))
        XCTAssertEqual(try store.folder(id: child.id).parent?.id, parent.id)
        XCTAssertEqual(try store.note(id: note.id).folder?.id, child.id)
        XCTAssertFalse(try store.note(id: note.id).isDeleted)
    }

    func testFailedContentSaveDoesNotLeakIntoTheNextSave() throws {
        let store = try makeStore()
        let note = try store.createNote(in: store.defaultFolder())
        try store.updateContent(note, attributed: attributed("Original"))
        XCTAssertThrowsError(
            try failingSaves(in: store).updateContent(note, attributed: attributed("Uncommitted")))
        _ = try store.createFolder(name: "Other", parent: nil)
        XCTAssertEqual(try store.note(id: note.id).title, "Original")
    }

    func testImportToDeletedNoteCleansUpItsFile() async throws {
        let store = try makeStore()
        let note = try store.createNote(in: store.defaultFolder())
        try store.softDelete(note)
        do {
            _ = try await store.importAttachment(
                to: note.id, filename: "late.txt", uti: nil, data: Data("late".utf8))
            XCTFail("An import must not attach to a deleted note")
        } catch {
            XCTAssertEqual(error as? NotesError, .noteNotFound)
        }
        XCTAssertTrue(try store.attachments.existingRelativePaths().isEmpty)
        XCTAssertTrue(try store.note(id: note.id).attachments.isEmpty)
    }

    func testFolderQueriesAndCountsExcludeOtherFoldersAndDeletedNotes() throws {
        let store = try makeStore()
        let first = try store.defaultFolder()
        let second = try store.createFolder(name: "Second", parent: nil)
        let active = try store.createNote(in: first)
        let deleted = try store.createNote(in: first)
        let other = try store.createNote(in: second)
        try store.softDelete(deleted)
        XCTAssertEqual(try store.notes(in: first).map(\.id), [active.id])
        XCTAssertEqual(try store.notes(in: second).map(\.id), [other.id])
        XCTAssertEqual(store.folderNoteCount(first), 1)
        XCTAssertEqual(store.folderNoteCount(second), 1)
        XCTAssertEqual(try store.allNotesCount(), 2)
        XCTAssertEqual(try store.deletedNotesCount(), 1)
        try store.moveNote(active, to: second)
        XCTAssertEqual(store.folderNoteCount(first), 0)
        XCTAssertEqual(store.folderNoteCount(second), 2)
        try store.recover(deleted)
        XCTAssertEqual(try store.allNotesCount(), 3)
        XCTAssertEqual(try store.deletedNotesCount(), 0)
    }

    private func failingSaves(in store: NotesStore) -> NotesStore {
        NotesStore(container: store.container, attachments: store.attachments) { _ in
            throw CocoaError(.fileWriteOutOfSpace)
        }
    }

    func testDefaultFolderIsCreatedOnceAndCannotBeDeleted() throws {
        let store = try makeStore()
        let first = try store.ensureDefaultFolder()
        let second = try store.ensureDefaultFolder()
        XCTAssertEqual(first.id, second.id)
        XCTAssertEqual(try store.allFolders().count, 1)
        XCTAssertThrowsError(try store.deleteFolder(first)) { error in
            XCTAssertEqual(error as? NotesError, .defaultFolderProtected)
        }
        XCTAssertEqual(try store.allFolders().count, 1)
    }

    func testFolderCreateRenameMoveAndNestedDeleteSoftDeletesNotes() throws {
        let store = try makeStore()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let parent = try store.createFolder(name: "Work", parent: nil, now: now)
        let child = try store.createFolder(name: "Design", parent: parent, now: now)
        let note = try store.createNote(in: child, now: now)
        try store.updateContent(
            note,
            attributed: attributed("Nested note\nBody"),
            now: now
        )

        try store.renameFolder(child, to: "Product", now: now.addingTimeInterval(10))
        XCTAssertEqual(try store.folder(id: child.id).name, "Product")

        let sibling = try store.createFolder(name: "Archive", parent: nil, now: now)
        try store.moveFolder(parent, to: sibling, now: now)
        XCTAssertEqual(try store.folder(id: parent.id).parent?.id, sibling.id)

        XCTAssertThrowsError(try store.moveFolder(sibling, to: parent)) { error in
            XCTAssertEqual(error as? NotesError, .invalidFolderMove)
        }

        try store.deleteFolder(sibling, now: now.addingTimeInterval(20))
        XCTAssertTrue(try store.allFolders().allSatisfy { $0.id != sibling.id && $0.id != parent.id })
        let deleted = try store.deletedNotes()
        XCTAssertEqual(deleted.map(\.id), [note.id])
        try store.recover(deleted[0], now: now.addingTimeInterval(30))
        XCTAssertEqual(try store.note(id: note.id).folder?.isDefault, true)
    }

    func testPinSortAndSearchCoverTitleBodyAndAttachmentNames() throws {
        let store = try makeStore()
        let folder = try store.defaultFolder()
        let older = Date(timeIntervalSince1970: 1_800_000_000)
        let newer = older.addingTimeInterval(60)

        let alpha = try store.createNote(in: folder, now: older)
        try store.updateContent(alpha, attributed: attributed("Alpha\nFirst body"), now: older)
        let beta = try store.createNote(in: folder, now: newer)
        try store.updateContent(beta, attributed: attributed("Beta\nSecond body"), now: newer)
        _ = try store.addAttachment(
            to: beta,
            filename: "receipt-scan.pdf",
            uti: "com.adobe.pdf",
            data: Data("synthetic-pdf".utf8),
            now: newer
        )

        try store.pin(alpha)
        let sorted = store.sortedNotes(try store.notes(in: folder), sort: .title)
        XCTAssertEqual(sorted.map(\.id), [alpha.id, beta.id])
        XCTAssertEqual(
            NotesStore.sortRegular([beta, alpha], by: .dateEdited).map(\.id),
            [beta.id, alpha.id]
        )
        XCTAssertEqual(
            NotesStore.sortRegular([beta, alpha], by: .title).map(\.id),
            [alpha.id, beta.id]
        )

        XCTAssertEqual(try store.search("alpha").map(\.id), [alpha.id])
        XCTAssertEqual(try store.search("second body").map(\.id), [beta.id])
        XCTAssertEqual(try store.search("receipt-scan").map(\.id), [beta.id])
        XCTAssertTrue(try store.search("missing-token").isEmpty)
    }

    func testSoftDeleteRecoverAndPermanentDelete() throws {
        let store = try makeStore()
        let now = Date(timeIntervalSince1970: 1_800_000_100)
        let note = try store.createNote(in: store.defaultFolder(), now: now)
        try store.updateContent(note, attributed: attributed("Keep me\nPlease"), now: now)
        try store.pin(note)
        try store.softDelete(note, now: now.addingTimeInterval(5))

        XCTAssertTrue(try store.notes(in: nil).isEmpty)
        XCTAssertEqual(try store.deletedNotes().map(\.id), [note.id])
        XCTAssertFalse(try store.note(id: note.id).isPinned)

        try store.recover(note, now: now.addingTimeInterval(10))
        XCTAssertEqual(try store.notes(in: nil).map(\.id), [note.id])
        XCTAssertTrue(try store.deletedNotes().isEmpty)

        try store.softDelete(note, now: now.addingTimeInterval(15))
        try store.permanentlyDelete(note)
        XCTAssertThrowsError(try store.note(id: note.id)) { error in
            XCTAssertEqual(error as? NotesError, .noteNotFound)
        }
    }

    func testExpiredDeletedNotesArePurgedOnlyWhenAsked() throws {
        let store = try makeStore()
        let created = Date(timeIntervalSince1970: 1_800_000_200)
        let note = try store.createNote(in: store.defaultFolder(), now: created)
        try store.updateContent(note, attributed: attributed("Old deleted"), now: created)
        try store.softDelete(note, now: created)

        XCTAssertEqual(
            try store.purgeExpiredDeletedNotes(now: created.addingTimeInterval(29 * 24 * 60 * 60)),
            0
        )
        XCTAssertEqual(try store.deletedNotes().count, 1)
        XCTAssertEqual(
            try store.purgeExpiredDeletedNotes(now: created.addingTimeInterval(30 * 24 * 60 * 60)),
            1
        )
        XCTAssertTrue(try store.deletedNotes().isEmpty)
    }

    func testEmptyNoteDeletionAndBlankFolderNameRejection() throws {
        let store = try makeStore()
        let empty = try store.createNote(in: store.defaultFolder())
        XCTAssertTrue(try store.deleteEmptyNoteIfNeeded(empty))
        XCTAssertThrowsError(try store.note(id: empty.id))

        let kept = try store.createNote(in: store.defaultFolder())
        try store.updateContent(kept, attributed: attributed("Kept"))
        XCTAssertFalse(try store.deleteEmptyNoteIfNeeded(kept))
        XCTAssertThrowsError(try store.createFolder(name: "   ", parent: nil)) { error in
            XCTAssertEqual(error as? NotesError, .invalidFolderName)
        }
    }

    func testAttachmentLifecycleAndOrphanCleanup() throws {
        let store = try makeStore()
        let note = try store.createNote(in: store.defaultFolder())
        let attachment = try store.addAttachment(
            to: note,
            filename: "image.jpg",
            uti: "public.jpeg",
            data: Data([0xFF, 0xD8, 0xFF])
        )
        let url = store.attachmentURL(attachment)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        XCTAssertTrue(try store.search("image.jpg").map(\.id).contains(note.id))

        try store.removeAttachment(attachment)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))

        let leftover = try store.addAttachment(
            to: note,
            filename: "keep.txt",
            uti: "public.plain-text",
            data: Data("hello".utf8)
        )
        let orphanRelative = try store.attachments.store(
            noteID: note.id,
            attachmentID: UUID(),
            filename: "orphan.txt",
            data: Data("lost".utf8)
        )
        XCTAssertEqual(try store.cleanupOrphanedAttachmentFiles(), 1)
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: store.attachments.url(for: orphanRelative).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.attachmentURL(leftover).path))
    }

    func testNotesStayOutOfCaptureDirectories() throws {
        let root = try temporaryDirectory()
        let notesRoot = root.appendingPathComponent("notes", isDirectory: true)
        let captureRoot = root.appendingPathComponent("capture", isDirectory: true)
        try FileManager.default.createDirectory(at: captureRoot, withIntermediateDirectories: true)
        let store = try NotesStore.open(root: notesRoot)
        let note = try store.createNote(in: store.defaultFolder())
        try store.updateContent(note, attributed: attributed("Local only"))
        _ = try store.addAttachment(
            to: note,
            filename: "local.txt",
            uti: "public.plain-text",
            data: Data("local".utf8)
        )

        let captureContents = try FileManager.default.contentsOfDirectory(atPath: captureRoot.path)
        XCTAssertTrue(captureContents.isEmpty)
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: notesRoot.appendingPathComponent("Notes.store").path))
    }

    func testUnreadableStoreLocationFailsClosedWithoutReset() throws {
        let root = try temporaryDirectory()
        let blocked = root.appendingPathComponent("notes")
        try Data("not-a-directory".utf8).write(to: blocked)
        let original = try Data(contentsOf: blocked)
        XCTAssertThrowsError(try NotesStore.open(root: blocked)) { error in
            guard case .storeUnavailable(let diagnostic) = error as? NotesError else {
                return XCTFail("store failure must stay a storeUnavailable error")
            }
            XCTAssertFalse(diagnostic.isEmpty)
        }
        XCTAssertEqual(try Data(contentsOf: blocked), original)
    }

    private func attributed(_ string: String) -> NSAttributedString {
        NSAttributedString(string: string, attributes: NoteFormatting.bodyAttributes())
    }

    private func makeStore() throws -> NotesStore {
        let root = try temporaryDirectory()
        return try NotesStore.inMemory(
            attachmentsRoot: root.appendingPathComponent("attachments", isDirectory: true)
        )
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(
            "lifestream-notes-tests-\(UUID().uuidString)",
            isDirectory: true
        )
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
}

extension NotesStoreTests {
    func testCancelledFileImportFinishesOwnershipAndDeletedNoteCleansCopy() async throws {
        let store = try makeStore()
        let note = try store.createNote(in: store.defaultFolder())
        let source = store.attachments.root.appendingPathComponent("synthetic-cancelled-import")
        try Data([1, 2, 3]).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        let task = Task {
            let imported = try await store.importAttachment(to: note.id, filename: "owned.bin", uti: nil, source: source)
            return store.attachmentURL(imported)
        }
        task.cancel()
        let importedURL = try await task.value
        XCTAssertEqual(try Data(contentsOf: importedURL), Data([1, 2, 3]))
        let before = try store.attachments.existingRelativePaths()
        note.deletedAt = Date()
        try store.context.save()
        do {
            _ = try await store.importAttachment(to: note.id, filename: "deleted.bin", uti: nil, source: source)
            XCTFail("Deleted note must reject metadata after the file copy")
        } catch { }
        XCTAssertEqual(try store.attachments.existingRelativePaths(), before)
    }

    func testFileImportPreservesSourceAndCleansFailedMetadataPublication() async throws {
        let store = try makeStore()
        let note = try store.createNote(in: store.defaultFolder())
        let source = store.attachments.root.appendingPathComponent("synthetic-import")
        let data = Data(repeating: 0xA5, count: 2_097_153)
        try data.write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        let imported = try await store.importAttachment(to: note.id, filename: "original.bin", uti: nil, source: source)
        XCTAssertEqual(imported.byteCount, data.count)
        XCTAssertEqual(try Data(contentsOf: store.attachmentURL(imported)), data)
        XCTAssertEqual(try Data(contentsOf: source), data)
        let before = try store.attachments.existingRelativePaths()
        do {
            _ = try await failingSaves(in: store).importAttachment(to: note.id, filename: "failure.bin", uti: nil, source: source)
            XCTFail("Failed metadata save must fail the import")
        } catch { }
        XCTAssertEqual(try store.attachments.existingRelativePaths(), before)
    }
}

extension NotesStoreTests {
    func testOptimizationNotesWorkloads() throws {
        guard ProcessInfo.processInfo.environment["OPTIMIZATION_BENCHMARK"] == "1" else {
            throw XCTSkip("Explicit Release Notes benchmark")
        }
        var rows: [[String: Any]] = []
        for count in [100, 1_000, 10_000] {
            let store = try makeStore()
            let parent = try store.defaultFolder()
            let child = try store.createFolder(name: "Synthetic child", parent: parent)
            for index in 0..<count {
                store.context.insert(Note(title: "Synthetic \(index)", searchText: "synthetic café \(index)", folder: child))
            }
            try store.context.save()
            var samples: [Double] = []
            var baseline: [Double] = []
            for index in 0...30 {
                let oldStart = CACurrentMediaTime()
                let old = try store.notes(in: nil).filter { NoteSearchIndex.matches(query: "CAFÉ", searchText: $0.searchText) }
                    .sorted { $0.modifiedAt > $1.modifiedAt }
                let oldElapsed = CACurrentMediaTime() - oldStart
                let start = CACurrentMediaTime()
                let current = try store.search("CAFÉ")
                let elapsed = CACurrentMediaTime() - start
                XCTAssertEqual(current.map(\.id), old.map(\.id))
                XCTAssertEqual(current.count, count)
                if index > 0 { samples.append(elapsed); baseline.append(oldElapsed) }
            }
            rows.append(["notes": count, "search_seconds": samples, "baseline_seconds": baseline,
                         "queries_per_search": 1, "query_tokenizations": count])
        }
        for count in [10_000, 100_000] {
            let session = NoteEditorSession(noteID: UUID(), createdAt: Date(), attributed: attributed(String(repeating: "x", count: count)))
            let view = UITextView()
            session.bind(textView: view)
            var samples: [Double] = []
            for index in 0...30 {
                let start = CACurrentMediaTime()
                session.textDidChange(view)
                if index > 0 { samples.append(CACurrentMediaTime() - start) }
            }
            rows.append(["characters": count, "model_conversion_seconds": samples])
        }
        let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: rows, options: [.prettyPrinted, .sortedKeys]),
            uniformTypeIdentifier: "public.json")
        attachment.name = "optimization-notes.json"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
