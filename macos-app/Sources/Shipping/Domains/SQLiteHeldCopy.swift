import Darwin
import Foundation
import SQLite3

enum SQLiteHeldCopy {
    static let attempts = 5
    static let sidecars = ["-journal", "-wal"]

    static func write(from source: URL, to output: URL, opener: FileOpener = .own) throws {
        do {
            try settledCopy(from: source, to: output, opener: opener)
            try settle(output)
        } catch {
            remove(output)
            throw error
        }
        removeSidecars(of: output)
    }

    struct Stamp: Equatable {
        let inode: UInt64
        let size: Int64
        let changed: timespec

        static func == (left: Stamp, right: Stamp) -> Bool {
            left.inode == right.inode && left.size == right.size
                && left.changed.tv_sec == right.changed.tv_sec && left.changed.tv_nsec == right.changed.tv_nsec
        }

        static func of(_ path: String) -> Stamp? {
            var facts = stat()
            guard lstat(path, &facts) == 0 else { return nil }
            return Stamp(inode: UInt64(facts.st_ino), size: Int64(facts.st_size), changed: facts.st_mtimespec)
        }
    }

    static func stamps(of source: URL) -> [Stamp?] {
        (sidecars.map { source.path + $0 } + [source.path]).map(Stamp.of)
    }

    private static func settledCopy(from source: URL, to output: URL, opener: FileOpener) throws {
        for _ in 0..<attempts {
            remove(output)
            let before = stamps(of: source)
            for suffix in sidecars {
                guard let file = try open(source.path + suffix, opener) else { continue }
                try clone(file, to: output.path + suffix)
            }
            guard let file = try open(source.path, opener) else { throw SQLiteHeldCopyError.copy(source.lastPathComponent, "it is gone") }
            try clone(file, to: output.path)
            if stamps(of: source) == before { return }
            usleep(50_000)
        }
        throw SQLiteHeldCopyError.unsettled(source.lastPathComponent, attempts)
    }

    private static func open(_ path: String, _ opener: FileOpener) throws -> OpenedFile? {
        let name = (path as NSString).lastPathComponent
        let opened: OpenedFile?
        do { opened = try opener.open(URL(fileURLWithPath: path)) } catch FileOpenerError.unreadable(let code) {
            if code == ENOENT { return nil }
            throw SQLiteHeldCopyError.copy(name, String(cString: strerror(code)))
        }
        if let opened { return opened }
        var facts = stat()
        guard lstat(path, &facts) == 0 else { return nil }
        throw SQLiteHeldCopyError.copy(name, "it cannot be opened")
    }

    private static func clone(_ file: OpenedFile, to: String) throws {
        let source = file.handle.fileDescriptor
        if fclonefileat(source, AT_FDCWD, to, 0) == 0 { return }
        guard errno == ENOTSUP || errno == EXDEV else {
            throw SQLiteHeldCopyError.copy(file.url.lastPathComponent, String(cString: strerror(errno)))
        }
        let target = Darwin.open(to, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
        guard target >= 0 else { throw SQLiteHeldCopyError.copy(file.url.lastPathComponent, String(cString: strerror(errno))) }
        defer { close(target) }
        guard lseek(source, 0, SEEK_SET) == 0, fcopyfile(source, target, nil, copyfile_flags_t(COPYFILE_DATA)) == 0 else {
            throw SQLiteHeldCopyError.copy(file.url.lastPathComponent, String(cString: strerror(errno)))
        }
    }

    private static func settle(_ copy: URL) throws {
        let handle = try SQLite.open(copy, flags: SQLITE_OPEN_READWRITE)
        defer { sqlite3_close(handle) }
        try SQLite.exec("PRAGMA synchronous=OFF", on: handle)
        guard try SQLite.passesQuickCheck(handle) else {
            throw SQLiteError.integrity(copy.lastPathComponent)
        }
        try SQLite.exec("PRAGMA journal_mode=DELETE", on: handle)
    }

    private static func remove(_ output: URL) {
        try? FileManager.default.removeItem(at: output)
        removeSidecars(of: output)
    }

    private static func removeSidecars(of output: URL) {
        for suffix in sidecars + ["-shm"] {
            try? FileManager.default.removeItem(at: URL(fileURLWithPath: output.path + suffix))
        }
    }
}

enum SQLiteHeldCopyError: PathFreeError, Equatable {
    case unsettled(String, Int)
    case copy(String, String)

    var description: String {
        switch self {
        case .unsettled(let name, let attempts): return "\(name) changed while it was copied, \(attempts) times"
        case .copy(let name, let why): return "could not copy \(name): \(why)"
        }
    }
}
