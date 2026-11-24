import Evidence
import DeviceFiles
import Foundation
import Darwin

enum SpoolFiles {
    static func isRealDirectory(_ url: URL) throws -> Bool {
        let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        return values.isDirectory == true && values.isSymbolicLink != true
    }

    static func exists(_ url: URL) throws -> Bool {
        var info = stat()
        if lstat(url.path, &info) == 0 {
            return true
        }
        guard errno == ENOENT else {
            throw CaptureStoreError.io("inspect archive path", errno)
        }
        return false
    }

    static func read(_ files: DeviceFiles, _ url: URL, maximumBytes: Int) throws -> Data {
        guard let bytes = try files.read(url, maximumBytes: maximumBytes) else {
            throw CaptureStoreError.io("open \(url.lastPathComponent)", ENOENT)
        }
        return bytes
    }

    static func isAbsence(_ error: Error) -> Bool {
        switch error {
        case DeviceFileError.io(_, ENOENT), CaptureStoreError.io(_, ENOENT):
            return true
        case let error as NSError where error.domain == NSCocoaErrorDomain:
            return error.code == NSFileNoSuchFileError || error.code == NSFileReadNoSuchFileError
        case let error as NSError where error.domain == NSPOSIXErrorDomain:
            return error.code == Int(ENOENT)
        default:
            return false
        }
    }

    static func children(of url: URL) throws -> [URL] {
        try FileManager.default.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]
        )
    }
}
