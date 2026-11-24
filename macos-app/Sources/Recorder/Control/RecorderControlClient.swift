import Darwin
import Foundation

public enum RecorderControlClient {
    public static func call(directory: URL, request: ControlRequest) async throws -> ControlResponse {
        let action = try request.validatedAction()
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(with: Result {
                    try exchange(directory: directory, request: request, seconds: action.clientDeadline)
                })
            }
        }
    }

    private static func exchange(directory: URL, request: ControlRequest,
                                 seconds: TimeInterval) throws -> ControlResponse {
        let paths = try ControlSocket.paths(directory: directory, create: false)
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw RecorderControlError.system(errno) }
        defer { Darwin.close(fd) }
        try ControlSocket.configure(fd)
        let deadline = Date().addingTimeInterval(seconds)
        try connect(fd, path: paths.socket, deadline: deadline)
        try ControlSocket.writeFrame(fd, data: JSONEncoder().encode(request), deadline: deadline)
        let data = try ControlSocket.readFrame(fd, maximum: 65536, deadline: deadline)
        guard let response = try? JSONDecoder().decode(ControlResponse.self, from: data) else {
            throw RecorderControlError.invalidResponse
        }
        return response
    }

    private static func connect(_ fd: Int32, path: String, deadline: Date) throws {
        let flags = fcntl(fd, F_GETFL)
        guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 else { throw RecorderControlError.system(errno) }
        defer { _ = fcntl(fd, F_SETFL, flags) }
        let connected = try ControlSocket.withAddress(path) { Darwin.connect(fd, $0, $1) }
        if connected == 0 { return }
        guard errno == EINPROGRESS else { throw RecorderControlError.unavailable }
        while true {
            let remaining = deadline.timeIntervalSinceNow
            guard remaining > 0 else { throw RecorderControlError.timeout }
            var event = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
            let milliseconds = Int32(min(250, max(1, ceil(remaining * 1000))))
            let result = Darwin.poll(&event, 1, milliseconds)
            if result < 0 && errno == EINTR { continue }
            guard result >= 0 else { throw RecorderControlError.system(errno) }
            if result == 0 { continue }
            var socketError: Int32 = 0
            var length = socklen_t(MemoryLayout<Int32>.size)
            guard getsockopt(fd, SOL_SOCKET, SO_ERROR, &socketError, &length) == 0 else {
                throw RecorderControlError.system(errno)
            }
            guard socketError == 0, event.revents & Int16(POLLNVAL | POLLERR | POLLHUP) == 0 else {
                throw RecorderControlError.unavailable
            }
            return
        }
    }
}
