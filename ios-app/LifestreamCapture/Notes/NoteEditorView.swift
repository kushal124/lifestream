import Cockpit
import ImageIO
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct NoteEditorView: View {
    let noteID: UUID
    var backTitle: String = "Notes"

    @EnvironmentObject private var notes: NotesController
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var sessionHolder = SessionBox()
    @State private var saveTask: Task<Void, Never>?
    @State private var didLeaveEmpty = false
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var isPickingPhoto = false
    @State private var isPickingFile = false
    @State private var isShowingCamera = false
    @State private var isShowingLinkSheet = false
    @State private var isShowingAttachMenu = false
    @State private var movingNote = false
    @State private var loadFailed = false

    var body: some View {
        Group {
            if let session = sessionHolder.session {
                editor(session)
            } else if loadFailed {
                NotesUnavailableView(sentence: "This note could not be opened.")
            } else {
                Loading()
                    .accessibilityIdentifier("notes.editor.loading")
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden()
        .task(id: noteID) {
            loadSession()
            if sessionHolder.session?.attributed.length == 0 {
                try? await Task.sleep(for: .milliseconds(150))
                sessionHolder.session?.textView?.becomeFirstResponder()
            }
        }
        .onDisappear { handleDisappear() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active {
                flushSave()
            }
        }
    }

    @ViewBuilder
    private func editor(_ session: NoteEditorSession) -> some View {
        VStack(spacing: 0) {
            Text(
                NotePreviewFormatting.editorTimestamp(
                    notes.value { try $0.note(id: noteID).modifiedAt } ?? session.createdAt)
            )
            .cockpit(.monoTime)
            .foregroundStyle(Cockpit.Color.textTertiary)
            .frame(maxWidth: .infinity)
            .padding(.top, Cockpit.Space.s2)
            .accessibilityIdentifier("notes.editor.date")
            NotesActLine(act: editing, notes: notes)
                .padding(.horizontal, Cockpit.Gap.edge)
            NoteTextView(
                session: session,
                onChange: scheduleSave,
                onChecklistToggle: { location in
                    session.applyToStorage { storage, _ in
                        NoteFormatting.toggleChecklistItem(in: storage, at: location)
                    }
                    scheduleSave()
                },
                onAttach: { isShowingAttachMenu = true }
            )
            NoteAttachmentStrip(
                attachments: currentAttachments,
                urlForAttachment: { attachment in
                    notes.store?.attachmentURL(attachment)
                        ?? AttachmentFileStore(root: URL(fileURLWithPath: "/tmp")).url(
                            for: attachment.relativePath
                        )
                },
                onRemove: { attachment in
                    notes.perform(editing) { store in
                        try store.removeAttachment(attachment)
                    }
                }
            )
        }
        .groundColor(Cockpit.Color.surface)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    if flushSave() { dismiss() }
                } label: {
                    HStack(spacing: Cockpit.Space.s1) {
                        Icon(.back)
                        Text(backTitle)
                    }
                }
                .accessibilityLabel("Back")
                .accessibilityIdentifier("notes.editor.back")
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Menu {
                    Button("Move") { if flushSave() { movingNote = true } }
                    Button("Delete", role: .destructive) {
                        guard flushSave() else { return }
                        if notes.perform(editing, { store in
                            try store.softDelete(try store.note(id: noteID))
                        }) {
                            dismiss()
                        }
                    }
                } label: {
                    Icon(.more)
                }
                .accessibilityIdentifier("notes.editor.more")
                .accessibilityLabel("Note actions")
                Button("Done") {
                    guard flushSave() else { return }
                    session.textView?.resignFirstResponder()
                    AppNavigation.shared.presented = nil
                }
                .fontWeight(.semibold)
                .accessibilityIdentifier("notes.editor.done")
            }
        }
        .confirmationDialog("Add attachment", isPresented: $isShowingAttachMenu) {
            Button("Photo library") { isPickingPhoto = true }
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button("Take photo") { isShowingCamera = true }
            }
            Button("Choose file") { isPickingFile = true }
            Button("Add link") { isShowingLinkSheet = true }
            Button("Cancel", role: .cancel) {}
        }
        .photosPicker(isPresented: $isPickingPhoto, selection: $selectedPhoto, matching: .images)
        .onChange(of: selectedPhoto) { _, item in
            guard let item else { return }
            Task { await importPhoto(item) }
        }
        .fileImporter(
            isPresented: $isPickingFile,
            allowedContentTypes: [.item],
            allowsMultipleSelection: false
        ) { result in
            importFile(result)
        }
        .sheet(isPresented: $isShowingCamera) {
            CameraPicker(
                onImage: { data, filename in
                    attach(data: data, filename: filename, uti: UTType.jpeg.identifier)
                    isShowingCamera = false
                },
                onCancel: { isShowingCamera = false }
            )
            .ignoresSafeArea()
        }
        .sheet(isPresented: $isShowingLinkSheet) {
            LinkEntrySheet(initialText: selectedText(in: session)) { url in
                session.insertLink(url)
                scheduleSave()
            }
        }
        .sheet(isPresented: $movingNote) {
            NoteMoveSheet { folderID in
                notes.perform(editing) { store in
                    try store.moveNote(store.note(id: noteID), to: store.folder(id: folderID))
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("notes.editor")
    }

    private var editing: NotesAct { .editing(noteID) }

    private var currentAttachments: [NoteAttachment] {
        notes.value { try $0.note(id: noteID).attachments.sorted { $0.createdAt < $1.createdAt } }
            ?? []
    }

    private func loadSession() {
        if sessionHolder.session?.noteID == noteID { return }
        do {
            let store = try notes.requireStore()
            let note = try store.note(id: noteID)
            let attributed = try RichTextCodec.decode(note.richTextData)
            sessionHolder.session = NoteEditorSession(
                noteID: note.id,
                createdAt: note.createdAt,
                attributed: attributed
            )
        } catch {
            loadFailed = true
        }
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            flushSave()
        }
    }

    @discardableResult
    private func flushSave() -> Bool {
        guard let session = sessionHolder.session, session.isDirty else { return true }
        return notes.perform(editing) { store in
            let note = try store.note(id: noteID)
            try store.updateContent(note, attributed: session.attributed)
            session.isDirty = false
        }
    }

    private func handleDisappear() {
        saveTask?.cancel()
        guard sessionHolder.session != nil, !loadFailed, flushSave() else { return }
        guard !didLeaveEmpty else { return }
        notes.perform(.note(noteID)) { store in
            let note = try store.note(id: noteID)
            didLeaveEmpty = try store.deleteEmptyNoteIfNeeded(note)
        }
    }

    private func importPhoto(_ item: PhotosPickerItem) async {
        defer { selectedPhoto = nil }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { return }
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                let identifier = CGImageSourceGetType(source),
                let type = UTType(identifier as String)
            else { throw NotesError.attachmentIO("This photo could not be read. Choose another photo.") }
            await attachImported(
                data: data, filename: "photo.\(type.preferredFilenameExtension ?? "image")",
                uti: type.identifier)
        } catch {
            notes.failed(editing, error) { isPickingPhoto = true }
        }
    }

    private func importFile(_ result: Result<[URL], Error>) {
        switch result {
        case .failure(let error):
            notes.failed(editing, error) { isPickingFile = true }
        case .success(let urls):
            guard let url = urls.first else { return }
            Task {
                let accessed = url.startAccessingSecurityScopedResource()
                defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                guard flushSave() else { return }
                await notes.perform(editing, again: { isPickingFile = true }) { store in
                    _ = try await store.importAttachment(to: noteID, filename: url.lastPathComponent,
                        uti: UTType(filenameExtension: url.pathExtension)?.identifier, source: url)
                }
            }
        }
    }

    private func attach(data: Data, filename: String, uti: String?) {
        guard flushSave() else { return }
        notes.perform(editing) { store in
            let note = try store.note(id: noteID)
            _ = try store.addAttachment(to: note, filename: filename, uti: uti, data: data)
        }
    }

    private func attachImported(data: Data, filename: String, uti: String?) async {
        guard flushSave() else { return }
        await notes.perform(editing, again: { isPickingPhoto = true }) { store in
            _ = try await store.importAttachment(to: noteID, filename: filename, uti: uti, data: data)
        }
    }

    private func selectedText(in session: NoteEditorSession) -> String {
        guard let textView = session.textView else { return "" }
        let range = textView.selectedRange
        guard range.length > 0 else { return "" }
        return (textView.attributedText.string as NSString).substring(with: range)
    }
}

@MainActor
private final class SessionBox: ObservableObject {
    @Published var session: NoteEditorSession?
}
