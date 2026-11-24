import Darwin
import Foundation

final class SQLiteSource {
    static let workPrefix = "sqlite-held-"

    let url: URL
    private var folder: URL?

    init(_ database: URL, opener: FileOpener = .own, scratch: URL) throws {
        var facts = stat()
        guard stat(database.path, &facts) == 0 else {
            let code = errno
            if code == ENOENT || code == ENOTDIR { throw SQLiteError.missing(database.lastPathComponent) }
            throw SQLiteError.denied(database.lastPathComponent, String(cString: strerror(code)))
        }
        let writerHolds = ["-wal", "-shm"].allSatisfy { suffix in
            var sidecar = stat()
            return stat(database.path + suffix, &sidecar) == 0
        }
        if writerHolds {
            for suffix in ["", "-wal", "-shm"] { try Self.check(URL(fileURLWithPath: database.path + suffix), opener) }
            url = database
            return
        }
        let folder = try SealWork.directory(prefix: Self.workPrefix, in: scratch)
        let copy = folder.appendingPathComponent(database.lastPathComponent)
        do { try SQLiteHeldCopy.write(from: database, to: copy, opener: opener) } catch {
            try? FileManager.default.removeItem(at: folder)
            throw error
        }
        url = copy
        self.folder = folder
    }

    private static func check(_ file: URL, _ opener: FileOpener) throws {
        do { _ = try opener.open(file) } catch let refused as StoreFiles.Unsafe { throw refused } catch {}
    }

    func close() {
        guard let folder else { return }
        try? FileManager.default.removeItem(at: folder)
        self.folder = nil
    }

    deinit { close() }
}
