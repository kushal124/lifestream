import Foundation
import LifestreamCaptureCore
import UniformTypeIdentifiers

struct AttachmentFileStore: Sendable {
    let root: URL

    init(root: URL) {
        self.root = root
    }

    func prepare() throws {
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        } catch {
            throw NotesError.attachmentIO(
                "Notes attachment directory could not be created: \(error.localizedDescription)"
            )
        }
    }

    func url(for relativePath: String) -> URL {
        relativePath.split(separator: "/").reduce(root) { partial, component in
            partial.appendingPathComponent(String(component), isDirectory: false)
        }
    }

    func store(
        noteID: UUID,
        attachmentID: UUID,
        filename: String,
        data: Data
    ) throws -> String {
        try prepare()
        let safeName = Self.sanitizedFilename(filename)
        let directory =
            root
            .appendingPathComponent(noteID.uuidString.lowercased(), isDirectory: true)
            .appendingPathComponent(attachmentID.uuidString.lowercased(), isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let fileURL = directory.appendingPathComponent(safeName, isDirectory: false)
            try data.write(to: fileURL, options: .atomic)
        } catch {
            throw NotesError.attachmentIO(
                "Notes could not store an attachment file: \(error.localizedDescription)"
            )
        }
        return [
            noteID.uuidString.lowercased(),
            attachmentID.uuidString.lowercased(),
            safeName,
        ].joined(separator: "/")
    }

    func store(noteID: UUID, attachmentID: UUID, filename: String, source: URL) throws -> (path: String, bytes: Int) {
        try prepare()
        let relativePath = [noteID.uuidString.lowercased(), attachmentID.uuidString.lowercased(),
                            Self.sanitizedFilename(filename)].joined(separator: "/")
        let destination = url(for: relativePath)
        do {
            try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileDurability.copyRegularFileDurably(from: source, to: destination)
            let bytes = try FileDurability.regularFileSize(at: destination)
            guard let count = Int(exactly: bytes) else { throw NotesError.attachmentIO("Choose a smaller attachment.") }
            return (relativePath, count)
        } catch {
            try? remove(relativePath: relativePath)
            throw NotesError.attachmentIO("Notes could not store an attachment file: \(error.localizedDescription)")
        }
    }

    func remove(relativePath: String) throws {
        let fileURL = url(for: relativePath)
        let attachmentDirectory = fileURL.deletingLastPathComponent()
        let noteDirectory = attachmentDirectory.deletingLastPathComponent()
        do {
            if FileManager.default.fileExists(atPath: fileURL.path) {
                try FileManager.default.removeItem(at: fileURL)
            }
            try removeDirectoryIfEmpty(attachmentDirectory)
            try removeDirectoryIfEmpty(noteDirectory)
        } catch {
            throw NotesError.attachmentIO(
                "Notes could not remove an attachment file: \(error.localizedDescription)"
            )
        }
    }

    func existingRelativePaths() throws -> Set<String> {
        guard FileManager.default.fileExists(atPath: root.path) else { return [] }
        let keys: [URLResourceKey] = [.isRegularFileKey]
        guard
            let enumerator = FileManager.default.enumerator(
                at: root,
                includingPropertiesForKeys: keys,
                options: [.skipsHiddenFiles]
            )
        else { return [] }

        var paths: Set<String> = []
        for case let fileURL as URL in enumerator {
            let values = try fileURL.resourceValues(forKeys: Set(keys))
            guard values.isRegularFile == true else { continue }
            let relative = fileURL.path.replacingOccurrences(of: root.path + "/", with: "")
            if !relative.isEmpty {
                paths.insert(relative)
            }
        }
        return paths
    }

    func cleanupOrphans(referencedPaths: Set<String>) throws -> Int {
        let existing = try existingRelativePaths()
        let orphans = existing.subtracting(referencedPaths)
        for path in orphans.sorted() {
            try remove(relativePath: path)
        }
        return orphans.count
    }

    static func sanitizedFilename(_ filename: String) -> String {
        let trimmed = filename.trimmingCharacters(in: .whitespacesAndNewlines)
        let replaced = trimmed.replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
        return replaced.isEmpty ? "attachment" : replaced
    }

    static func inferredUTI(filename: String, fallback: String? = nil) -> String {
        if let fallback, !fallback.isEmpty { return fallback }
        let ext = (filename as NSString).pathExtension
        if let type = UTType(filenameExtension: ext) {
            return type.identifier
        }
        return UTType.data.identifier
    }

    private func removeDirectoryIfEmpty(_ url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        let contents = try FileManager.default.contentsOfDirectory(atPath: url.path)
        if contents.isEmpty {
            try FileManager.default.removeItem(at: url)
        }
    }
}
