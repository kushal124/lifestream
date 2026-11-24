import CryptoKit
import DeviceFiles
import Foundation
import Network
import XCTest
@testable import HomeLink

final class UploadTests: XCTestCase {
    private var folder: URL!
    private let files = DeviceFiles(.keyed(SymmetricKey(size: .bits256)))
    private let payload = Data((0..<3_000_000).map { UInt8(($0 * 7) % 251) })

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("homelink-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func request(_ door: LoopbackDoor, _ bundle: URL) throws -> HomeRequest {
        let files = files
        let size = Int64(try files.size(of: bundle))
        return HomeRequest(method: "PUT", url: URL(string: door.name + "/v1/acquisitions/sha256%3A00aa")!,
                           headers: ["Content-Type": "application/zip"],
                           body: .stream(size: size, open: HomeRequest.Opener { try files.reader(bundle) }), timeout: 30)
    }

    func testAKeyedBundleReachesARealDoorThroughURLSessionAsItsPlainBytesWhole() async throws {
        let bundle = folder.appendingPathComponent("b.zip")
        try files.writeNew(bundle, payload, flush: .data)
        XCTAssertNotEqual(try Data(contentsOf: bundle).prefix(1024), payload.prefix(1024), "the file on disk is keyed")
        let door = try await LoopbackDoor.start()
        defer { door.stop() }
        let response = try await URLSessionTransport().perform(try request(door, bundle))
        XCTAssertEqual(response.status, 201, "the door answered before the request's wait")
        let got = try XCTUnwrap(door.bodies.first)
        XCTAssertEqual(got.length, String(payload.count), "the body states its plain length")
        XCTAssertEqual(got.body.count, payload.count, "the door read the whole body")
        XCTAssertEqual(got.body, payload, "the door got the plain bytes")
        XCTAssertTrue(door.cut.isEmpty)
    }

    func testAReadThatFailsMidBodyFailsTheUploadWithItsError() async throws {
        let bundle = folder.appendingPathComponent("b.zip")
        try files.writeNew(bundle, payload, flush: .data)
        var disk = try Data(contentsOf: bundle)
        disk[1_500_000] ^= 1
        try disk.write(to: bundle)
        let door = try await LoopbackDoor.start()
        defer { door.stop() }
        do {
            _ = try await URLSessionTransport().perform(try request(door, bundle))
            XCTFail("a damaged file fails its upload")
        } catch {
            XCTAssertTrue(error is DeviceFileError, "the read's own error, not the request's wait: \(error)")
        }
        XCTAssertTrue(door.bodies.isEmpty, "the door never got a whole body")
    }
}

private final class LoopbackDoor: @unchecked Sendable {
    struct Received {
        let length: String?
        let body: Data
    }

    private let listener: NWListener
    private let queue = DispatchQueue(label: "loopback-door")
    private let lock = NSLock()
    private var whole: [Received] = []
    private var short: [Data] = []

    private init(listener: NWListener) {
        self.listener = listener
    }

    static func start() async throws -> LoopbackDoor {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let door = LoopbackDoor(listener: try NWListener(using: parameters))
        door.listener.newConnectionHandler = { [door] connection in door.serve(connection) }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            door.listener.stateUpdateHandler = { state in
                switch state {
                case .ready: continuation.resume()
                case .failed(let error): continuation.resume(throwing: error)
                default: break
                }
            }
            door.listener.start(queue: door.queue)
        }
        door.listener.stateUpdateHandler = nil
        return door
    }

    var name: String { "http://127.0.0.1:\(listener.port!.rawValue)" }
    var bodies: [Received] { lock.withLock { whole } }
    var cut: [Data] { lock.withLock { short } }

    func stop() { listener.cancel() }

    private func serve(_ connection: NWConnection) {
        connection.start(queue: queue)
        read(connection, Data())
    }

    private func read(_ connection: NWConnection, _ held: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [self] data, _, done, failure in
            let got = held + (data ?? Data())
            guard let end = got.range(of: Data("\r\n\r\n".utf8)) else {
                if done || failure != nil { return connection.cancel() }
                return read(connection, got)
            }
            var length: String?
            for line in String(decoding: got[..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n") {
                guard let colon = line.firstIndex(of: ":"), line[..<colon].lowercased() == "content-length" else { continue }
                length = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            }
            let body = Data(got[end.upperBound...])
            guard body.count >= Int(length ?? "0") ?? 0 else {
                if done || failure != nil {
                    lock.withLock { short.append(body) }
                    return connection.cancel()
                }
                return read(connection, got)
            }
            lock.withLock { whole.append(Received(length: length, body: body)) }
            let answer = "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
            connection.send(content: Data(answer.utf8), completion: .contentProcessed { _ in connection.cancel() })
        }
    }
}
