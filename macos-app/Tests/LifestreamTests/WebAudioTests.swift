import AppKit
import Foundation
import Network
import XCTest
@testable import Lifestream

final class WebAudioTests: XCTestCase {
    static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../packages/core/test/audio")
        .standardizedFileURL

    static let served: [(name: String, type: String)] = [
        ("whatsapp.ogg", "audio/ogg"),
        ("imessage-opus.caf", "audio/x-caf"),
        ("imessage-aac.caf", "audio/x-caf"),
        ("iphone.m4a", "audio/mp4"),
    ]

    static let page = "<!doctype html><html><body></body></html>"

    static let loading = """
    const audio = new Audio();
    audio.preload = 'auto';
    audio.muted = true;
    const answer = new Promise(done => {
      audio.addEventListener('loadeddata', () => done({ loaded: true, seconds: audio.duration }), { once: true });
      audio.addEventListener('error', () => done({ loaded: false, code: audio.error ? audio.error.code : -1 }), { once: true });
    });
    audio.src = path;
    audio.load();
    return await answer;
    """

    @MainActor func testEveryKeptVoiceNoteFormatLoadsInTheAppsWebKitAsTheMediaRouteServesIt() async throws {
        var files: [String: (type: String, body: Data)] = ["/": ("text/html", Data(Self.page.utf8))]
        for (name, type) in Self.served {
            files["/\(name)"] = (type, try Data(contentsOf: Self.fixtures.appendingPathComponent(name)))
        }
        let server = try RangedServer(files)
        defer { server.stop() }
        let port = try await server.ready()
        let suite = "WebAudioTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        let web = WebContent(address: DashboardAddress(port: port), defaults: defaults, release: nil, dashboardHeld: { false })
        defer { web.close() }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 320), styleMask: [.titled], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        window.contentView = web.container
        defer { window.close() }
        web.start()
        try await until("the page loaded") { web.loaded }
        let page = try XCTUnwrap(web.page)

        for (name, _) in Self.served {
            let answer = try await page.callAsyncJavaScript(Self.loading, arguments: ["path": "/\(name)"], in: nil, contentWorld: .page)
            let loaded = try XCTUnwrap(answer as? [String: Any], "\(name) answered nothing")
            XCTAssertEqual(loaded["loaded"] as? Bool, true, "\(name) did not load: media error \(loaded["code"] ?? "none")")
            let seconds = try XCTUnwrap(loaded["seconds"] as? Double, "\(name) has no length")
            XCTAssertEqual(seconds, 2.8, accuracy: 0.2, "\(name) loaded at the wrong length")
        }
    }
}

final class RangedServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "RangedServer")
    private var waiting: CheckedContinuation<Int, Error>?

    init(_ files: [String: (type: String, body: Data)]) throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [queue] connection in
            connection.start(queue: queue)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { request, _, _, _ in
                let head = request.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                let path = head.split(separator: " ").dropFirst().first.map(String.init) ?? ""
                let response = Self.response(files[path] ?? files[String(path.prefix { $0 != "?" })], range: Self.range(in: head))
                connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
            }
        }
    }

    static func range(in head: String) -> (from: Int, to: Int?)? {
        guard let line = head.split(separator: "\r\n").first(where: { $0.lowercased().hasPrefix("range: bytes=") }) else { return nil }
        let bounds = line.dropFirst("range: bytes=".count).split(separator: "-", omittingEmptySubsequences: false)
        guard let from = bounds.first.flatMap({ Int($0) }) else { return nil }
        return (from, bounds.dropFirst().first.flatMap { Int($0) })
    }

    static func response(_ file: (type: String, body: Data)?, range: (from: Int, to: Int?)?) -> Data {
        guard let file else { return Data("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8) }
        let size = file.body.count
        guard let range, range.from < size else {
            return Data("HTTP/1.1 200 OK\r\nContent-Type: \(file.type)\r\nAccept-Ranges: bytes\r\nContent-Length: \(size)\r\nConnection: close\r\n\r\n".utf8)
                + file.body
        }
        let to = min(range.to ?? size - 1, size - 1)
        let part = file.body.subdata(in: range.from..<(to + 1))
        return Data(("HTTP/1.1 206 Partial Content\r\nContent-Type: \(file.type)\r\nAccept-Ranges: bytes\r\n"
            + "Content-Range: bytes \(range.from)-\(to)/\(size)\r\nContent-Length: \(part.count)\r\nConnection: close\r\n\r\n").utf8) + part
    }

    func ready() async throws -> Int {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Int, Error>) in
            queue.async { [self] in
                waiting = continuation
                listener.stateUpdateHandler = { [self] state in
                    switch state {
                    case .ready: waiting?.resume(returning: Int(listener.port?.rawValue ?? 0))
                    case .failed(let error): waiting?.resume(throwing: error)
                    default: return
                    }
                    waiting = nil
                }
                listener.start(queue: queue)
            }
        }
    }

    func stop() { listener.cancel() }
}
