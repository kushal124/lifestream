import Cockpit
import SwiftUI

struct FolderNameSheet: View {
    let title: String
    let initialName: String
    var showsParentPicker: Bool = true
    let onSave: (String, UUID?) throws -> Void

    @EnvironmentObject private var notes: NotesController
    @State private var name: String
    @State private var parentID: UUID?

    init(
        title: String,
        initialName: String,
        showsParentPicker: Bool = true,
        onSave: @escaping (String, UUID?) throws -> Void
    ) {
        self.title = title
        self.initialName = initialName
        self.showsParentPicker = showsParentPicker
        self.onSave = onSave
        _name = State(initialValue: initialName)
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Folder name", text: $name)
                    .cockpit(.body)
                    .foregroundStyle(Cockpit.Color.text)
                    .accessibilityIdentifier("notes.folder.name")
                    .notesRows()
                if showsParentPicker {
                    Picker("Location", selection: $parentID) {
                        Text("On my iPhone").tag(Optional<UUID>.none)
                        ForEach(notes.value { try $0.allFolders() } ?? [], id: \.id) { folder in
                            Text(folder.name).tag(Optional(folder.id))
                        }
                    }
                    .cockpit(.body)
                    .foregroundStyle(Cockpit.Color.text)
                    .accessibilityIdentifier("notes.folder.parent")
                    .notesRows()
                }
            }
            .notesList()
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .sheetEditBar(SheetEdit(opened: Named(name: initialName, parent: nil), now: Named(name: trimmed, parent: parentID),
                                    ready: !trimmed.isEmpty, identifier: "notes.folder") {
                try onSave(trimmed, parentID)
                return .close
            })
        }
        .drawerRest(.medium)
    }

    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    private struct Named: Equatable {
        let name: String
        let parent: UUID?
    }
}

struct FolderMoveSheet: View {
    let folderID: UUID
    let onMove: (UUID?) -> Void

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var notes: NotesController
    @State private var parentID: UUID?

    var body: some View {
        NavigationStack {
            List {
                Group {
                    Button("On my iPhone") {
                        onMove(nil)
                        dismiss()
                    }
                    ForEach(eligibleParents, id: \.id) { folder in
                        Button(folder.name) {
                            onMove(folder.id)
                            dismiss()
                        }
                    }
                }
                .cockpit(.body)
                .notesRows()
            }
            .notesList()
            .navigationTitle("Move folder")
            .navigationBarTitleDisplayMode(.inline)
            .sheetCloseBar()
        }
        .drawerRest(.medium)
    }

    private var eligibleParents: [NoteFolder] {
        (notes.value { try $0.allFolders() } ?? []).filter { $0.id != folderID }
    }
}

struct NoteMoveSheet: View {
    let onMove: (UUID) -> Void

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var notes: NotesController

    var body: some View {
        NavigationStack {
            List {
                ForEach(notes.value { try $0.allFolders() } ?? [], id: \.id) { folder in
                    Button(folder.name) {
                        onMove(folder.id)
                        dismiss()
                    }
                    .cockpit(.body)
                    .accessibilityIdentifier(
                        "notes.move.folder.\(folder.id.uuidString.lowercased())"
                    )
                    .notesRows()
                }
            }
            .notesList()
            .navigationTitle("Move")
            .navigationBarTitleDisplayMode(.inline)
            .sheetCloseBar()
        }
        .drawerRest(.medium)
    }
}

struct LinkEntrySheet: View {
    let initialText: String
    let onSave: (URL) -> Void

    @State private var text: String

    init(initialText: String, onSave: @escaping (URL) -> Void) {
        self.initialText = initialText
        self.onSave = onSave
        _text = State(initialValue: initialText)
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("URL", text: $text)
                    .cockpit(.body)
                    .foregroundStyle(Cockpit.Color.text)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("notes.link.url")
                    .notesRows()
            }
            .notesList()
            .navigationTitle("Add link")
            .navigationBarTitleDisplayMode(.inline)
            .sheetEditBar(SheetEdit(ready: sanitizedURL != nil, identifier: "notes.link") {
                guard let url = sanitizedURL else { return .stay }
                onSave(url)
                return .close
            })
        }
        .drawerRest(.medium)
    }

    private var sanitizedURL: URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: trimmed), url.scheme != nil {
            return url
        }
        return URL(string: "https://\(trimmed)")
    }
}
