import Darwin
import Foundation

public enum OwnerOnly {
    public static let folderMode: mode_t = 0o700
    public static let fileMode: mode_t = 0o600

    public static func folder(_ folder: URL) {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: Int(folderMode)])
        chmod(folder.path, folderMode)
    }

    public static func append(_ file: URL) -> Int32 {
        folder(file.deletingLastPathComponent())
        let fd = Darwin.open(file.path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_CLOEXEC, fileMode)
        if fd >= 0 { fchmod(fd, fileMode) }
        return fd
    }

    public static func narrow(_ folder: URL) {
        var info = stat()
        guard lstat(folder.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else { return }
        chmod(folder.path, folderMode)
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else { return }
        for name in names {
            let item = folder.appendingPathComponent(name)
            guard lstat(item.path, &info) == 0 else { continue }
            switch info.st_mode & S_IFMT {
            case S_IFDIR: narrow(item)
            case S_IFREG: chmod(item.path, fileMode)
            default: continue
            }
        }
    }
}
