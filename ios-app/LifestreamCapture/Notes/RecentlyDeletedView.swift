import Cockpit
import LifestreamCaptureCore
import SwiftUI

struct RecentlyDeletedView: View {
    @EnvironmentObject private var notes: NotesController
    @State private var searchText = ""
    @State private var pendingDeletion: UUID?
    @State private var isConfirmingPermanentDelete = false

    var body: some View {
        List {
            Section {
                ForEach(deletedNotes, id: \.id) { note in
                    NoteRowView(note: note, now: AppClock.now, showsRetention: true)
                        .accessibilityIdentifier("notes.deleted.\(note.id.uuidString.lowercased())")
                        .notesOutcome(.note(note.id), notes)
                        .contextMenu {
                            Button {
                                recover(note.id)
                            } label: {
                                Label("Recover", systemImage: "arrow.uturn.backward")
                            }
                            Button(role: .destructive) {
                                confirmPermanentDelete(of: note.id)
                            } label: {
                                Label("Delete forever", systemImage: "trash")
                            }
                        }
                        .swipeActions(edge: .leading) {
                            Button {
                                recover(note.id)
                            } label: {
                                Label("Recover", systemImage: "arrow.uturn.backward")
                            }
                            .notesSwipe(.neutral)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                confirmPermanentDelete(of: note.id)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                            .notesSwipe(.destructive)
                        }
                }
            } footer: {
                if !deletedNotes.isEmpty {
                    Text("Notes stay here for 30 days, then they are deleted for good.")
                        .cockpit(.footnote)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                }
            }
            .notesRows()
        }
        .notesList()
        .overlay {
            if deletedNotes.isEmpty {
                if searchText.isEmpty {
                    EmptyState(.note, "Deleted notes stay here for 30 days.")
                } else {
                    EmptyState(.search, "No deleted notes match this search.")
                }
            }
        }
        .navigationTitle("Recently deleted")
        .confirmationDialog(
            "Delete this note for good?",
            isPresented: $isConfirmingPermanentDelete,
            titleVisibility: .visible,
            presenting: pendingDeletion
        ) { id in
            Button("Delete this note", role: .destructive) {
                permanentlyDelete(id)
                pendingDeletion = nil
            }
            Button("Cancel", role: .cancel) { pendingDeletion = nil }
        } message: { _ in
            Text("This note and its attachments cannot be recovered.")
        }
        .navigationBarTitleDisplayMode(.large)
        .notesSearch($searchText)
        .onAppear { _ = notes.value { try $0.purgeExpiredDeletedNotes() } }
        .accessibilityIdentifier("notes.recently-deleted")
    }

    private var deletedNotes: [Note] {
        let fetched = notes.value { try $0.deletedNotes() } ?? []
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return fetched }
        return fetched.filter { NoteSearchIndex.matches(query: query, searchText: $0.searchText) }
    }

    private func confirmPermanentDelete(of noteID: UUID) {
        pendingDeletion = noteID
        isConfirmingPermanentDelete = true
    }

    private func recover(_ id: UUID) {
        notes.perform(.note(id)) { store in
            try store.recover(try store.note(id: id))
        }
    }

    private func permanentlyDelete(_ id: UUID) {
        notes.perform(.note(id)) { store in
            try store.permanentlyDelete(try store.note(id: id))
        }
    }
}
