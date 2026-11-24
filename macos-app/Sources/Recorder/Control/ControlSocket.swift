import CryptoKit
import Darwin
import Foundation

enum ControlSocket {
    struct Paths {
        let socket: String
        let lock: String
    }

    static func paths(directory: URL, create: Bool) throws -> Paths {
        let canonical = directory.standardizedFileURL.resolvingSymlinksInPath().path
        let digest = SHA256.hash(data: Data(canonical.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
        let parent = "/tmp/lifestream-control-\(getuid())-\(digest)"
        if create && Darwin.mkdir(parent, 0o700) != 0 && errno != EEXIST {
            throw RecorderControlError.system(errno)
        }
        var info = stat()
        guard lstat(parent, &info) == 0 else { throw RecorderControlError.unavailable }
        guard info.st_uid == getuid(), info.st_mode & S_IFMT == S_IFDIR, info.st_mode & 0o777 == 0o700 else {
            throw RecorderControlError.unsafePath
        }
        return Paths(socket: parent + "/control.sock", lock: parent + "/instance.lock")
    }

    static func withAddress<T>(_ path: String,
                               _ operation: (UnsafePointer<sockaddr>, socklen_t) throws -> T) throws -> T {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8) + [0]
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw RecorderControlError.unsafePath }
        withUnsafeMutableBytes(of: &address.sun_path) { target in target.copyBytes(from: bytes) }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        return try withUnsafePointer(to: &address) { pointer in
            try pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                try operation($0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
    }

    static func configure(_ fd: Int32) throws {
        var enabled: Int32 = 1
        guard setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            throw RecorderControlError.system(errno)
        }
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        let flags = fcntl(fd, F_GETFL)
        guard flags >= 0, fcntl(fd, F_SETFL, flags & ~O_NONBLOCK) == 0 else { throw RecorderControlError.system(errno) }
    }

    static func readFrame(_ fd: Int32, maximum: Int, deadline: Date) throws -> Data {
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while true {
            try applyTimeout(fd, deadline: deadline)
            let size = Darwin.recv(fd, &buffer, buffer.count, 0)
            if size < 0 && errno == EINTR { continue }
            if size < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { throw RecorderControlError.timeout }
            guard size > 0 else { throw RecorderControlError.invalidRequest }
            if let newline = buffer.prefix(size).firstIndex(of: 10) {
                guard result.count + newline <= maximum else { throw RecorderControlError.oversized }
                guard newline == size - 1 else { throw RecorderControlError.invalidRequest }
                result.append(contentsOf: buffer[..<newline])
                return result
            }
            result.append(contentsOf: buffer.prefix(size))
            guard result.count <= maximum else { throw RecorderControlError.oversized }
        }
    }

    static func writeFrame(_ fd: Int32, data: Data, deadline: Date) throws {
        var frame = data
        frame.append(10)
        try frame.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            var offset = 0
            while offset < bytes.count {
                try applyTimeout(fd, deadline: deadline)
                let size = Darwin.send(fd, base.advanced(by: offset), bytes.count - offset, 0)
                if size < 0 && errno == EINTR { continue }
                if size < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { throw RecorderControlError.timeout }
                guard size > 0 else { throw RecorderControlError.system(errno) }
                offset += size
            }
        }
    }

    private static func applyTimeout(_ fd: Int32, deadline: Date) throws {
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0 else { throw RecorderControlError.timeout }
        var timeout = timeval(tv_sec: Int(remaining), tv_usec: Int32((remaining - floor(remaining)) * 1_000_000))
        let size = socklen_t(MemoryLayout<timeval>.size)
        guard setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, size) == 0,
              setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, size) == 0 else {
            throw RecorderControlError.system(errno)
        }
    }
}
