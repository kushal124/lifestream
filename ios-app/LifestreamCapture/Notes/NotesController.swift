import Cockpit
import Foundation
import os
import SwiftUI

enum NotesAct: Hashable {
    case newNote(page: String?)
    case newFolder
    case folder(UUID)
    case note(UUID)
    case editing(UUID)
}

@MainActor
final class NotesController: ObservableObject {
    enum Availability: Equatable {
        case ready
        case failed(String)
    }

    @Published private(set) var availability: Availability
    @Published private(set) var outcomes: [NotesAct: ActOutcome] = [:]
    private var retries: [NotesAct: () -> Void] = [:]
    private static let log = Logger(subsystem: "org.lifestreamprotocol.phone", category: "notes")
    @Published var sort: NoteSort {
        didSet { UserDefaults.standard.set(sort.rawValue, forKey: Self.sortDefaultsKey) }
    }

    let store: NotesStore?

    private static let sortDefaultsKey = "notes.sort"

    init(store: NotesStore) {
        self.store = store
        availability = .ready
        sort =
            NoteSort(rawValue: UserDefaults.standard.string(forKey: Self.sortDefaultsKey) ?? "")
            ?? .dateEdited
    }

    init(unavailable diagnostic: String) {
        store = nil
        availability = .failed(diagnostic)
        sort = .dateEdited
    }

    init() {
        sort =
            NoteSort(rawValue: UserDefaults.standard.string(forKey: Self.sortDefaultsKey) ?? "")
            ?? .dateEdited
        do {
            let opened = try NotesStore.open(root: NotesStore.defaultRoot())
            store = opened
            availability = .ready
            do {
                _ = try opened.cleanupOrphanedAttachmentFiles()
            } catch {
                Self.log.error("Attachment cleanup failed: \(String(describing: error), privacy: .public)")
            }
        } catch {
            store = nil
            availability = .failed(error.localizedDescription)
        }
    }

    func requireStore() throws -> NotesStore {
        guard let store else {
            if case .failed(let words) = availability { throw NotesError.storeUnavailable(words) }
            throw NotesError.storeUnavailable("Notes store is unavailable.")
        }
        return store
    }

    @discardableResult
    func perform(_ act: NotesAct, _ operation: @escaping (NotesStore) throws -> Void) -> Bool {
        defer { objectWillChange.send() }
        do {
            try operation(try requireStore())
            landed(act)
            return true
        } catch {
            failed(act, error) { [weak self] in self?.perform(act, operation) }
            return false
        }
    }

    func keep(_ operation: (NotesStore) throws -> Void) throws {
        defer { objectWillChange.send() }
        try operation(try requireStore())
    }

    func perform(_ act: NotesAct, again: @escaping () -> Void, _ operation: (NotesStore) async throws -> Void) async {
        do {
            try await operation(try requireStore())
            landed(act)
        } catch {
            failed(act, error, again: again)
        }
        objectWillChange.send()
    }

    func failed(_ act: NotesAct, _ error: any Error, again: @escaping () -> Void) {
        outcomes[act] = .refused(error)
        retries[act] = again
    }

    private func landed(_ act: NotesAct) {
        outcomes[act] = nil
        retries[act] = nil
    }

    func outcome(_ act: NotesAct) -> ActOutcome { outcomes[act] ?? .idle }

    func again(_ act: NotesAct) {
        let retry = retries[act]
        landed(act)
        retry?()
    }

    func value<T>(_ operation: (NotesStore) throws -> T) -> T? {
        do {
            return try operation(try requireStore())
        } catch {
            Self.log.error("A notes read failed: \(String(describing: error), privacy: .public)")
            return nil
        }
    }
}

struct NotesActLine: View {
    let act: NotesAct
    @ObservedObject var notes: NotesController

    var body: some View {
        if let failure = notes.outcome(act).failure {
            InPlaceLine(failure) { notes.again(act) }
                .accessibilityIdentifier("notes.failed")
        }
    }
}

extension View {
    func notesOutcome(_ act: NotesAct, _ notes: NotesController) -> some View {
        actOutcome(notes.outcome(act), identifier: "notes.failed") { notes.again(act) }
    }
}
