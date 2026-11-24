import Foundation

enum NotesError: LocalizedError, Equatable {
    case storeUnavailable(String)
    case folderNotFound
    case noteNotFound
    case attachmentNotFound
    case defaultFolderProtected
    case invalidFolderName
    case invalidFolderMove
    case attachmentIO(String)
    case richText(String)

    var errorDescription: String? {
        switch self {
        case .storeUnavailable(let diagnostic):
            diagnostic
        case .folderNotFound:
            "That folder is no longer in the Notes store."
        case .noteNotFound:
            "That note is no longer in the Notes store."
        case .attachmentNotFound:
            "That attachment is no longer in the Notes store."
        case .defaultFolderProtected:
            "The default Notes folder cannot be deleted."
        case .invalidFolderName:
            "A folder needs a name."
        case .invalidFolderMove:
            "A folder cannot be moved into itself or one of its descendants."
        case .attachmentIO(let diagnostic):
            diagnostic
        case .richText(let diagnostic):
            diagnostic
        }
    }
}

enum NoteSort: String, CaseIterable, Identifiable {
    case dateEdited
    case dateCreated
    case title

    var id: String { rawValue }

    var title: String {
        switch self {
        case .dateEdited: "Date edited"
        case .dateCreated: "Date created"
        case .title: "Title"
        }
    }

    var short: String {
        switch self {
        case .dateEdited: "Edited"
        case .dateCreated: "Created"
        case .title: "Title"
        }
    }
}

enum NotesRetention {
    static let deletedNoteLifetime: TimeInterval = 30 * 24 * 60 * 60
}
