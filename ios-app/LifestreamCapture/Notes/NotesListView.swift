import Cockpit
import LifestreamCaptureCore
import SwiftUI

struct NotesListView: View {
    let folderID: UUID?
    let title: String

    @EnvironmentObject private var notes: NotesController
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var searchText = ""
    @State private var movingNoteID: UUID?
    @State private var openedNoteID: UUID?
    @State private var isPinnedCollapsed = false

    var body: some View {
        let visible = visibleNotes
        noteList(visible)
            .safeAreaInset(edge: .top, spacing: 0) {
                NotesActLine(act: newNote, notes: notes)
                    .padding(.horizontal, Cockpit.Gap.edge)
                    .groundColor(Cockpit.Color.surface)
            }
            .notesSearch($searchText)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.large)
            .toolbar { listToolbar }
            .pageFoot {
                if !visible.isEmpty {
                    Text(Words.count(visible.count, "note"))
                        .cockpit(.footnote)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.bottom, Cockpit.Space.s2)
                        .accessibilityIdentifier("notes.list.count")
                }
            }
            .navigationDestination(item: openedItem) { item in
                NoteEditorView(noteID: item.id, backTitle: title)
            }
            .sheet(item: movingItem) { item in
                NoteMoveSheet { folderID in
                    notes.perform(.note(item.id)) { store in
                        try store.moveNote(store.note(id: item.id), to: store.folder(id: folderID))
                    }
                }
            }
            .accessibilityIdentifier("notes.list")
    }

    private var openedItem: Binding<IdentifiedUUID?> {
        Binding(
            get: { openedNoteID.map(IdentifiedUUID.init) },
            set: { openedNoteID = $0?.id }
        )
    }

    private var movingItem: Binding<IdentifiedUUID?> {
        Binding(
            get: { movingNoteID.map(IdentifiedUUID.init) },
            set: { movingNoteID = $0?.id }
        )
    }

    @ToolbarContentBuilder
    private var listToolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            MenuRow("Sort notes", selection: $notes.sort, options: NoteSort.allCases.map { MenuRow.Option($0, $0.title) },
                    words: notes.sort.short, pill: true)
                .fixedSize()
                .accessibilityIdentifier("notes.sort")
        }
        .sharedBackgroundVisibility(.hidden)
        ToolbarItem(placement: .topBarTrailing) {
            Button(action: compose) {
                Icon(.add)
            }
            .accessibilityIdentifier("notes.new-note")
            .accessibilityLabel("New note")
        }
    }

    private func noteList(_ visible: [Note]) -> some View {
        let pinned = visible.filter(\.isPinned)
        let groups = NoteGroup.grouping(visible.filter { !$0.isPinned }, sort: notes.sort, now: AppClock.now)
        return List {
            if !pinned.isEmpty {
                Section {
                    if !isPinnedCollapsed {
                        ForEach(pinned, id: \.id) { note in
                            noteRow(note)
                        }
                    }
                } header: {
                    pinnedHeader.notesHeader()
                }
                .notesRows()
            }
            ForEach(groups) { group in
                Section {
                    ForEach(group.notes, id: \.id) { note in
                        noteRow(note, grouped: notes.sort == .dateEdited)
                    }
                } header: {
                    if let title = group.title {
                        SectionLabel(title).notesHeader()
                    }
                }
                .notesRows()
            }
        }
        .notesList()
        .overlay {
            if visible.isEmpty {
                if searchText.isEmpty {
                    EmptyState(.note, "No notes here yet.", action: "New note", perform: compose)
                } else {
                    EmptyState(.search, "No notes match this search.")
                }
            }
        }
    }

    private var pinnedHeader: some View {
        Button {
            withAnimation(reduceMotion ? nil : Cockpit.Ease.spring()) { isPinnedCollapsed.toggle() }
        } label: {
            HStack(spacing: Cockpit.Space.s1) {
                Text("Pinned")
                    .cockpit(.monoLabel)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                Icon(.expand, size: .xs)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .rotationEffect(isPinnedCollapsed ? .degrees(-90) : .zero)
            }
            .frame(maxWidth: .infinity, minHeight: Cockpit.Size.target, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .textCase(nil)
        .accessibilityLabel("Pinned")
        .accessibilityValue(isPinnedCollapsed ? "Collapsed" : "Expanded")
        .accessibilityIdentifier("notes.pinned.toggle")
    }

    @ViewBuilder
    private func noteMenu(_ note: Note) -> some View {
        Button {
            togglePin(note.id)
        } label: {
            Label(note.isPinned ? "Unpin" : "Pin", systemImage: note.isPinned ? "pin.slash" : "pin")
        }
        Button {
            movingNoteID = note.id
        } label: {
            Label("Move", systemImage: "folder")
        }
        Button(role: .destructive) {
            deleteNote(note.id)
        } label: {
            Label("Delete", systemImage: "trash")
        }
    }

    private var visibleNotes: [Note] {
        let folder = folderID.flatMap { id in notes.value { try $0.folder(id: id) } }
        let fetched = notes.value { try $0.notes(in: folder) } ?? []
        let sorted = notes.store?.sortedNotes(fetched, sort: notes.sort) ?? fetched
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return sorted }
        return sorted.filter { NoteSearchIndex.matches(query: query, searchText: $0.searchText) }
    }

    private func noteRow(_ note: Note, grouped: Bool = false) -> some View {
        Button {
            openedNoteID = note.id
        } label: {
            NoteRowView(note: note, now: AppClock.now, grouped: grouped)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("notes.note.\(note.id.uuidString.lowercased())")
        .notesOutcome(.note(note.id), notes)
        .contextMenu { noteMenu(note) }
        .swipeActions(edge: .leading) {
            Button {
                togglePin(note.id)
            } label: {
                Label(note.isPinned ? "Unpin" : "Pin", systemImage: "pin.fill")
            }
            .notesSwipe(.neutral)
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                deleteNote(note.id)
            } label: {
                Label("Delete", systemImage: "trash")
            }
            .notesSwipe(.destructive)
            Button {
                movingNoteID = note.id
            } label: {
                Label("Move", systemImage: "folder")
            }
            .notesSwipe(.neutral)
        }
    }

    private func togglePin(_ id: UUID) {
        notes.perform(.note(id)) { store in
            let current = try store.note(id: id)
            if current.isPinned {
                try store.unpin(current)
            } else {
                try store.pin(current)
            }
        }
    }

    private func deleteNote(_ id: UUID) {
        notes.perform(.note(id)) { store in
            try store.softDelete(try store.note(id: id))
        }
    }

    private var newNote: NotesAct { .newNote(page: folderID?.uuidString ?? "all") }

    private func compose() {
        notes.perform(newNote) { store in
            let folder = try folderID.map { try store.folder(id: $0) } ?? store.defaultFolder()
            openedNoteID = try store.createNote(in: folder).id
        }
    }
}

struct NoteGroup: Identifiable {
    let id: String
    let title: String?
    let notes: [Note]

    static func grouping(_ notes: [Note], sort: NoteSort, now: Date) -> [NoteGroup] {
        guard !notes.isEmpty else { return [] }
        if sort == .title {
            return [NoteGroup(id: "notes", title: "Notes", notes: notes)]
        }
        var ordered: [String] = []
        var members: [String: [Note]] = [:]
        for note in notes {
            let date = sort == .dateCreated ? note.createdAt : note.modifiedAt
            let title = NotePreviewFormatting.groupTitle(date, now: now)
            if members[title] == nil {
                ordered.append(title)
                members[title] = []
            }
            members[title]?.append(note)
        }
        return ordered.map { NoteGroup(id: $0, title: $0, notes: members[$0] ?? []) }
    }
}

struct NoteRowView: View {
    let note: Note
    let now: Date
    var grouped: Bool = false
    var showsRetention: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(note.displayTitle)
                .cockpit(.rowTitle)
                .foregroundStyle(Cockpit.Color.text)
                .lineLimit(1)
            HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s2) {
                Text(NotePreviewFormatting.listDate(note.modifiedAt, now: now, grouped: grouped))
                    .cockpit(.monoTime)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .layoutPriority(1)
                preview
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .lineLimit(1)
            }
            if showsRetention, let deletedAt = note.deletedAt {
                Text(NotePreviewFormatting.remainingRetention(deletedAt: deletedAt, now: now))
                    .cockpit(.footnote)
                    .foregroundStyle(Cockpit.Color.textTertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    @ViewBuilder private var preview: some View {
        if let snippet {
            Text("\u{201C}\(snippet)\u{201D}").cockpit(.voice)
        } else {
            Text(fallback).cockpit(.subhead)
        }
    }

    private var snippet: String? {
        let snippet = note.snippet.trimmingCharacters(in: .whitespacesAndNewlines)
        return snippet.isEmpty ? nil : snippet
    }

    private var fallback: String {
        note.attachments.isEmpty ? "No more text" : note.attachments.map(\.filename).joined(separator: ", ")
    }

    private var accessibilityText: String {
        var parts = [
            note.displayTitle,
            snippet ?? fallback,
            NotePreviewFormatting.listDate(note.modifiedAt, now: now, grouped: grouped),
        ]
        if !note.attachments.isEmpty {
            parts.append(Words.count(note.attachments.count, "attachment"))
        }
        if showsRetention, let deletedAt = note.deletedAt {
            parts.append(
                NotePreviewFormatting.remainingRetention(deletedAt: deletedAt, now: now)
            )
        }
        return parts.joined(separator: ", ")
    }
}

struct IdentifiedUUID: Identifiable, Hashable {
    let id: UUID

    init(_ id: UUID) {
        self.id = id
    }
}

enum NotesSwipeTone {
    case neutral, destructive
}

extension View {
    func notesList(_ margin: CGFloat = Cockpit.Gap.sheet) -> some View {
        listStyle(.insetGrouped)
            .contentMargins(.horizontal, margin, for: .scrollContent)
            .scrollContentBackground(.hidden)
            .groundColor(Cockpit.Color.surface)
    }

    func notesRows() -> some View {
        listRowBackground(Cockpit.Color.raised)
            .listRowInsets(EdgeInsets(
                top: Cockpit.Space.s2, leading: Cockpit.Space.s4, bottom: Cockpit.Space.s2, trailing: Cockpit.Space.s4))
            .listRowSeparatorTint(Cockpit.Color.rule)
    }

    func notesSearch(_ text: Binding<String>) -> some View {
        safeAreaInset(edge: .top, spacing: 0) {
            SearchField(text: text, placeholder: "Search")
                .padding(.horizontal, Cockpit.Gap.sheet)
                .padding(.vertical, Cockpit.Space.s2)
                .groundColor(Cockpit.Color.surface)
        }
    }

    func notesHeader() -> some View {
        listRowInsets(EdgeInsets(
            top: Cockpit.Space.s2, leading: 0, bottom: Cockpit.Space.s2, trailing: Cockpit.Space.s4))
    }

    func notesSwipe(_ tone: NotesSwipeTone) -> some View {
        tint(tone == .destructive ? Cockpit.Color.warning : Cockpit.Color.strokeControl)
    }
}
