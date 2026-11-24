import Darwin
import Foundation

@MainActor public final class RecorderControlServer {
    private let transport: ControlTransport

    public init(directory: URL, didRespond: @escaping @MainActor @Sendable (ControlResponse) -> Void = { _ in },
                handler: @escaping @MainActor @Sendable (ControlRequest) async -> ControlResponse) throws {
        transport = try ControlTransport(directory: directory, didRespond: didRespond, handler: handler)
    }

    public func close() {
        transport.close()
    }

    deinit {
        transport.close()
    }
}

private final class ControlTransport: @unchecked Sendable {
    private let stateLock = NSLock()
    private let queue = DispatchQueue(label: "lifestream.control")
    private var listener: Int32 = -1
    private var lockFD: Int32 = -1
    private var source: DispatchSourceRead?
    private var handlingRequest = false
    private let paths: ControlSocket.Paths
    private let handler: @MainActor @Sendable (ControlRequest) async -> ControlResponse
    private let didRespond: @MainActor @Sendable (ControlResponse) -> Void

    init(directory: URL, didRespond: @escaping @MainActor @Sendable (ControlResponse) -> Void,
         handler: @escaping @MainActor @Sendable (ControlRequest) async -> ControlResponse) throws {
        paths = try ControlSocket.paths(directory: directory, create: true)
        self.handler = handler
        self.didRespond = didRespond
        lockFD = Darwin.open(paths.lock, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard lockFD >= 0 else { throw RecorderControlError.system(errno) }
        guard flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
            Darwin.close(lockFD)
            lockFD = -1
            throw RecorderControlError.alreadyRunning
        }
        do {
            try listen()
        } catch {
            close()
            throw error
        }
    }

    private func listen() throws {
        var old = stat()
        if lstat(paths.socket, &old) == 0 {
            guard old.st_uid == getuid(), old.st_mode & S_IFMT == S_IFSOCK else {
                throw RecorderControlError.unsafePath
            }
            guard unlink(paths.socket) == 0 else { throw RecorderControlError.system(errno) }
        }
        listener = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { throw RecorderControlError.system(errno) }
        try ControlSocket.configure(listener)
        let listener = self.listener
        guard try ControlSocket.withAddress(paths.socket, { Darwin.bind(listener, $0, $1) }) == 0,
              chmod(paths.socket, 0o600) == 0,
              Darwin.listen(listener, 8) == 0,
              fcntl(listener, F_SETFL, O_NONBLOCK) == 0 else { throw RecorderControlError.system(errno) }
        let source = DispatchSource.makeReadSource(fileDescriptor: listener, queue: queue)
        self.source = source
        source.setEventHandler { [weak self] in self?.acceptRequest() }
        source.resume()
    }

    func close() {
        stateLock.lock()
        defer { stateLock.unlock() }
        if handlingRequest { source?.resume() }
        source?.cancel()
        source = nil
        if listener >= 0 {
            Darwin.close(listener)
            listener = -1
            _ = unlink(paths.socket)
        }
        if lockFD >= 0 {
            _ = flock(lockFD, LOCK_UN)
            Darwin.close(lockFD)
            lockFD = -1
        }
    }

    private func acceptRequest() {
        stateLock.lock()
        let fd = listener >= 0 ? Darwin.accept(listener, nil, nil) : -1
        if fd >= 0 {
            handlingRequest = true
            source?.suspend()
        }
        stateLock.unlock()
        guard fd >= 0 else { return }
        do {
            try ControlSocket.configure(fd)
            var uid: uid_t = 0
            var gid: gid_t = 0
            guard getpeereid(fd, &uid, &gid) == 0, uid == getuid() else { throw RecorderControlError.invalidRequest }
            let data = try ControlSocket.readFrame(fd, maximum: 8192, deadline: Date().addingTimeInterval(2))
            let request = try JSONDecoder().decode(ControlRequest.self, from: data)
            _ = try request.validatedAction()
            Task { @MainActor [self, handler] in
                let response = await handler(request)
                queue.async { [self] in finishRequest(fd, response: response) }
            }
        } catch {
            finishRequest(fd, response: ControlResponse(ok: false, state: "error",
                                                       message: "Control request rejected or timed out"))
        }
    }

    private func finishRequest(_ fd: Int32, response: ControlResponse) {
        defer {
            Darwin.close(fd)
            stateLock.lock()
            handlingRequest = false
            source?.resume()
            stateLock.unlock()
        }
        guard let encoded = try? JSONEncoder().encode(response), encoded.count <= 65536 else { return }
        do {
            try ControlSocket.writeFrame(fd, data: encoded, deadline: Date().addingTimeInterval(2))
            Task { @MainActor [didRespond] in didRespond(response) }
        } catch {
        }
    }
}
