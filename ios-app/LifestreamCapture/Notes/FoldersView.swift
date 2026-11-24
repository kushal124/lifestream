import Cockpit
import LifestreamCaptureCore
import SwiftUI

enum NotesOpening: Hashable {
    case folders
    case allNotes
    case newNote
    case note(UUID)
}

struct NotesRootView: View {
    var opening = NotesOpening.folders
    @EnvironmentObject private var notes: NotesController

    var body: some View {
        Group {
            switch notes.availability {
            case .failed(let diagnostic):
                NotesUnavailableView(sentence: "\(diagnostic) The notes on this phone were left as they were.")
            case .ready:
                FoldersView(opening: opening)
            }
        }
        .tint(Cockpit.Color.text)
    }
}

struct NotesUnavailableView: View {
    let sentence: String

    var body: some View {
        InPlaceLine(sentence)
            .padding(Cockpit.Space.s4)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .groundColor(Cockpit.Color.surface)
            .accessibilityIdentifier("notes.unavailable")
    }
}

struct FoldersView: View {
    var opening: NotesOpening
    @State private var didOpenInitialNote = false
    @EnvironmentObject private var notes: NotesController
    @State private var path: [NotesRoute] = []
    @State private var searchText = ""
    @State private var isCreatingFolder = false
    @State private var renamingFolderID: UUID?
    @State private var movingFolderID: UUID?
    @State private var folderPendingDeleteID: UUID?
    @State private var isConfirmingFolderDelete = false
    @State private var large: Bool
    @State private var listed: CGFloat?
    @State private var safeFoot: CGFloat = 0

    init(opening: NotesOpening = .folders) {
        self.opening = opening
        if case .folders = opening { _large = State(initialValue: false) } else { _large = State(initialValue: true) }
    }

    var body: some View {
        NavigationStack(path: $path) {
            SheetMargined { margin in folders(margin) }
            .task {
                guard !didOpenInitialNote else { return }
                didOpenInitialNote = true
                switch opening {
                case .folders: break
                case .allNotes: path.append(.allNotes)
                case .newNote: composeInDefaultFolder()
                case .note(let id): path.append(.note(id: id))
                }
            }
            .navigationDestination(for: NotesRoute.self) { route in
                switch route {
                case .folder(let id, let title):
                    NotesListView(folderID: id, title: title)
                case .allNotes:
                    NotesListView(folderID: nil, title: "All notes")
                case .recentlyDeleted:
                    RecentlyDeletedView()
                case .note(let id):
                    NoteEditorView(noteID: id, backTitle: "Folders")
                }
            }
            .sheet(isPresented: $isCreatingFolder) {
                FolderNameSheet(title: "New folder", initialName: "") { name, parent in
                    try notes.keep { store in
                        let resolvedParent = try parent.flatMap { try store.folder(id: $0) }
                        _ = try store.createFolder(name: name, parent: resolvedParent)
                    }
                }
            }
            .sheet(item: Binding(
                get: { renamingFolderID.map { IdentifiedUUID($0) } },
                set: { renamingFolderID = $0?.id }
            )) { identity in
                FolderNameSheet(
                    title: "Rename folder",
                    initialName: folderName(id: identity.id),
                    showsParentPicker: false
                ) { name, _ in
                    try notes.keep { store in
                        try store.renameFolder(store.folder(id: identity.id), to: name)
                    }
                }
            }
            .sheet(item: Binding(
                get: { movingFolderID.map { IdentifiedUUID($0) } },
                set: { movingFolderID = $0?.id }
            )) { identity in
                FolderMoveSheet(folderID: identity.id) { parentID in
                    notes.perform(.folder(identity.id)) { store in
                        let parent = try parentID.flatMap { try store.folder(id: $0) }
                        try store.moveFolder(try store.folder(id: identity.id), to: parent)
                    }
                }
            }
        }
        .presentationDetents([fitted, .large], selection: Binding(get: { large ? .large : fitted }, set: { large = $0 == .large }))
        .onChange(of: path) { if !path.isEmpty { large = true } }
        .onSheetFootChange { safeFoot = max(safeFoot, $0) }
        .confirmationDialog(
            "Delete this folder?",
            isPresented: $isConfirmingFolderDelete,
            titleVisibility: .visible,
            presenting: folderPendingDeleteID
        ) { id in
            Button("Delete this folder", role: .destructive) {
                notes.perform(.folder(id)) { store in
                    try store.deleteFolder(try store.folder(id: id))
                }
                folderPendingDeleteID = nil
            }
        } message: { _ in
            Text("Its notes move to Recently deleted.")
        }
    }

    private var fitted: PresentationDetent {
        guard let listed else { return .medium }
        let head = Cockpit.Space.s3 + Cockpit.Size.target + Cockpit.Gap.group + Cockpit.Size.target
        return .height(Cockpit.sheetAsked(head + Cockpit.Gap.head + listed + Cockpit.Gap.sheet, strip: safeFoot))
    }

    private func folders(_ margin: CGFloat) -> some View {
        VStack(spacing: 0) {
            SearchField(text: $searchText, placeholder: "Search")
                .padding(.horizontal, margin)
                .padding(.top, Cockpit.Gap.group)
            NotesActLine(act: .newNote(page: nil), notes: notes)
                .padding(.horizontal, margin)
            Group {
                if searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    folderList(margin)
                } else {
                    searchResults(margin)
                }
            }
        }
        .groundColor(Cockpit.Color.surface)
        .rootBar("Folders", sheet: true, margin: margin) {
            Text("Folders")
                .cockpit(.title1)
                .foregroundStyle(Cockpit.Color.text)
                .rootTitleLine()
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("root.title")
                .foldsOnRootLine()
        } controls: {
            DrawerCircle(.note, label: "New note", action: composeInDefaultFolder)
                .accessibilityIdentifier("notes.folders.new-note")
            DrawerClose { AppNavigation.shared.presented = nil }
                .accessibilityLabel("Back to home")
                .accessibilityIdentifier("capture.close")
        }
    }

    private func folderList(_ margin: CGFloat) -> some View {
        List {
            Section {
                folderLink(
                    title: "All notes",
                    count: notes.value { try $0.allNotesCount() } ?? 0,
                    identifier: "notes.folder.all",
                    route: .allNotes
                )
                ForEach(folderRows, id: \.id) { row in
                    folderLink(
                        title: row.name,
                        count: row.noteCount,
                        identifier: "notes.folder.\(row.id.uuidString.lowercased())",
                        depth: row.depth,
                        route: .folder(id: row.id, title: row.name)
                    )
                    .notesOutcome(.folder(row.id), notes)
                    .contextMenu {
                        if !row.isDefault {
                            Button {
                                renamingFolderID = row.id
                            } label: {
                                Label("Rename", systemImage: "pencil")
                            }
                            Button {
                                movingFolderID = row.id
                            } label: {
                                Label("Move", systemImage: "folder")
                            }
                            Button(role: .destructive) {
                                confirmDelete(of: row.id)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        if !row.isDefault {
                            Button(role: .destructive) {
                                confirmDelete(of: row.id)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                            .notesSwipe(.destructive)
                            Button {
                                renamingFolderID = row.id
                            } label: {
                                Label("Rename", systemImage: "pencil")
                            }
                            .notesSwipe(.neutral)
                        }
                    }
                }
                folderLink(
                    title: "Recently deleted",
                    count: notes.value { try $0.deletedNotesCount() } ?? 0,
                    identifier: "notes.folder.deleted",
                    route: .recentlyDeleted
                )
                ListRow("New folder", separator: false) { isCreatingFolder = true }
                    .environment(\.cockpitRowActs, true)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .accessibilityIdentifier("notes.new-folder")
                    .notesOutcome(.newFolder, notes)
            } header: {
                SectionLabel("On my iPhone").notesHeader()
            }
            .notesRows()
        }
        .listRowSpacing(-1)
        .notesList(margin)
        .contentMargins(.top, Cockpit.Gap.head, for: .scrollContent)
        .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, height in listed = height }
        .accessibilityIdentifier("notes.folders")
    }

    private func searchResults(_ margin: CGFloat) -> some View {
        let matches = notes.value { try $0.search(searchText) } ?? []
        return List {
            ForEach(matches, id: \.id) { note in
                Button {
                    path.append(.note(id: note.id))
                } label: {
                    NoteRowView(note: note, now: AppClock.now)
                }
                .buttonStyle(.plain)
                .notesRows()
                .accessibilityIdentifier("notes.search.row.\(note.id.uuidString.lowercased())")
            }
        }
        .notesList(margin)
        .overlay {
            if matches.isEmpty {
                EmptyState(.search, "No notes match this search.")
            }
        }
        .accessibilityIdentifier("notes.search.results")
    }

    private var folderRows: [FolderRow] {
        guard let folders = notes.value({ try $0.allFolders() }) else { return [] }
        let byParent = Dictionary(grouping: folders) { $0.parent?.id }
        var rows: [FolderRow] = []
        func append(from parentID: UUID?, depth: Int) {
            let children = (byParent[parentID] ?? []).sorted {
                if $0.sortIndex != $1.sortIndex { return $0.sortIndex < $1.sortIndex }
                return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
            for folder in children {
                rows.append(
                    FolderRow(
                        id: folder.id,
                        name: folder.name,
                        noteCount: notes.store?.folderNoteCount(folder) ?? 0,
                        depth: depth,
                        isDefault: folder.isDefault
                    )
                )
                append(from: folder.id, depth: depth + 1)
            }
        }
        append(from: nil, depth: 0)
        return rows
    }

    private func folderName(id: UUID) -> String {
        notes.value { try $0.folder(id: id).name } ?? ""
    }

    private func confirmDelete(of folderID: UUID) {
        folderPendingDeleteID = folderID
        isConfirmingFolderDelete = true
    }

    private func composeInDefaultFolder() {
        notes.perform(.newNote(page: nil)) { store in
            let note = try store.createNote(in: try store.defaultFolder())
            path.append(.note(id: note.id))
        }
    }

    private func folderLink(
        title: String,
        count: Int,
        identifier: String,
        depth: Int = 0,
        route: NotesRoute
    ) -> some View {
        ListRow(title, value: Words.count(count), chevron: true, action: { path.append(route) })
            .padding(.leading, CGFloat(depth) * Cockpit.Space.s5)
            .padding(.bottom, 1)
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .accessibilityIdentifier(identifier)
            .accessibilityLabel("\(title), \(Words.count(count, "note"))")
    }
}

enum NotesRoute: Hashable {
    case allNotes
    case recentlyDeleted
    case folder(id: UUID, title: String)
    case note(id: UUID)
}

private struct FolderRow {
    let id: UUID
    let name: String
    let noteCount: Int
    let depth: Int
    let isDefault: Bool
}
