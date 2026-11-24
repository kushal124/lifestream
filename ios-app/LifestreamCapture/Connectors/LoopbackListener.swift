import Foundation
import Network
import os


final class LoopbackListener: @unchecked Sendable {
    private(set) var port = 0
    let caught: AsyncStream<String>
    private let found: AsyncStream<String>.Continuation
    private let listener: NWListener
    private let queue = DispatchQueue(label: "org.lifestreamprotocol.phone.loopback")

    private init() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        listener = try NWListener(using: parameters)
        (caught, found) = AsyncStream.makeStream(of: String.self)
    }

    static func open() async throws -> LoopbackListener {
        let opened = try LoopbackListener()
        try await opened.start()
        return opened
    }

    private func start() async throws {
        listener.newConnectionHandler = { [weak self] connection in self?.serve(connection) }
        let resumed = OSAllocatedUnfairLock(initialState: false)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            listener.stateUpdateHandler = { [weak self] state in
                let outcome: Result<Void, Error>? = switch state {
                case .ready: .success(())
                case .failed(let error): .failure(error)
                case .cancelled: .failure(CancellationError())
                default: nil
                }
                guard let outcome, !resumed.withLock({ let was = $0; $0 = true; return was }) else { return }
                if case .success = outcome, let self { self.port = Int(self.listener.port?.rawValue ?? 0) }
                continuation.resume(with: outcome)
            }
            listener.start(queue: queue)
        }
    }

    private func serve(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, _, _ in
            let line = data.flatMap { String(data: $0, encoding: .utf8) }?.components(separatedBy: "\r\n").first ?? ""
            let parts = line.split(separator: " ")
            let path = parts.count >= 2 ? String(parts[1]) : "/"
            let page = "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\">"
                + "<p style=\"font:17px -apple-system,sans-serif;padding:24px\">You can close this page</p>"
            let reply = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(page.utf8.count)\r\nConnection: close\r\n\r\n" + page
            connection.send(content: Data(reply.utf8), completion: .contentProcessed { _ in connection.cancel() })
            guard let self, path.contains("code=") || path.contains("error=") else { return }
            self.found.yield("http://127.0.0.1:\(self.port)\(path)")
        }
    }

    func close() {
        listener.cancel()
        found.finish()
    }
}
