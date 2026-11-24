import Foundation
import XCTest
import CryptoKit
import Darwin
@testable import Recorder

final class RecorderControlTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("recorder-control-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws {
        let parent = socketPath().deletingLastPathComponent
        if FileManager.default.fileExists(atPath: parent) { try FileManager.default.removeItem(atPath: parent) }
        try FileManager.default.removeItem(at: root)
    }
    private func socketPath() -> NSString {
        let canonical = root.standardizedFileURL.resolvingSymlinksInPath().path
        let digest = SHA256.hash(data: Data(canonical.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
        return "/tmp/lifestream-control-\(getuid())-\(digest)/control.sock" as NSString
    }
    @MainActor func testStartPauseAndStatusReachExistingServer() async throws {
        var state = "paused"
        let server = try RecorderControlServer(directory: root) { request in
            if request.action == "start" { state = "recording" }
            if request.action == "pause" { state = "paused" }
            return ControlResponse(ok: true, state: state, captures: 7, gaps: 1)
        }
        defer { server.close() }
        let started = try await call("start", durationSeconds: 900)
        XCTAssertEqual(started.state, "recording")
        let status = try await call("status")
        XCTAssertEqual(status.captures, 7)
        let paused = try await call("pause")
        XCTAssertEqual(paused.state, "paused")
    }
    @MainActor func testSecondServerCannotOwnPausedApp() throws {
        let server = try RecorderControlServer(directory: root) { _ in ControlResponse(ok: true, state: "paused") }
        defer { server.close() }
        XCTAssertThrowsError(try RecorderControlServer(directory: root) { _ in
            ControlResponse(ok: true, state: "paused")
        })
        var info = stat()
        XCTAssertEqual(lstat(socketPath().utf8String, &info), 0)
        XCTAssertEqual(info.st_mode & 0o777, 0o600)
    }
    @MainActor func testServerRecoversStaleSocketAfterLockAcquisition() async throws {
        let first = try RecorderControlServer(directory: root) { _ in ControlResponse(ok: true, state: "paused") }
        first.close()
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(fd, 0)
        let bound = Self.bind(fd, path: socketPath() as String)
        Darwin.close(fd)
        XCTAssertEqual(bound, 0)
        let reopened = try RecorderControlServer(directory: root) { _ in ControlResponse(ok: true, state: "paused") }
        defer { reopened.close() }
        let response = try await call("status")
        XCTAssertTrue(response.ok)
    }
    func testNoServerFails() async {
        do {
            _ = try await call("status")
            XCTFail("Expected unavailable")
        } catch {}
    }
    @MainActor func testMalformedUnknownOversizedFramesDoNotInvokeHandler() async throws {
        var calls = 0
        let server = try RecorderControlServer(directory: root) { _ in
            calls += 1
            return ControlResponse(ok: true, state: "paused")
        }
        defer { server.close() }
        let path = socketPath() as String
        let payloads = [Data("not-json\n".utf8), Data("{\"action\":\"unknown\"}\n".utf8),
                        Data(repeating: 97, count: 9000)]
        for payload in payloads {
            let response = try await rawRequest(path: path, data: payload)
            XCTAssertFalse(response.ok)
        }
        XCTAssertEqual(calls, 0)
        for request in [ControlRequest(action: "unknown"), ControlRequest(action: "start", durationSeconds: -1),
                        ControlRequest(action: "start", durationSeconds: 86401),
                        ControlRequest(action: "pause", durationSeconds: 2)] {
            do {
                _ = try await RecorderControlClient.call(directory: root, request: request)
                XCTFail("Expected invalid request")
            } catch { XCTAssertTrue(error is RecorderControlError) }
        }
        XCTAssertEqual(calls, 0)
        let healthy = try await call("status")
        XCTAssertTrue(healthy.ok)
        XCTAssertEqual(calls, 1)
    }

    @MainActor func testIncompleteFrameTimesOutAndServerRemainsUsable() async throws {
        let server = try RecorderControlServer(directory: root) { _ in ControlResponse(ok: true, state: "paused") }
        defer { server.close() }
        let started = Date()
        let response = try await rawRequest(path: socketPath() as String, data: Data("{".utf8))
        XCTAssertFalse(response.ok)
        XCTAssertLessThan(Date().timeIntervalSince(started), 4)
        let healthy = try await call("status")
        XCTAssertTrue(healthy.ok)
    }

    @MainActor func testSaturatedAcceptQueueCannotBlockClientIndefinitely() async throws {
        let setup = try RecorderControlServer(directory: root) { _ in ControlResponse(ok: true, state: "paused") }
        setup.close()
        let listener = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { throw RecorderControlError.system(errno) }
        defer { Darwin.close(listener) }
        let path = socketPath() as String
        XCTAssertEqual(Self.bind(listener, path: path), 0)
        XCTAssertEqual(Darwin.listen(listener, 1), 0)
        var fillers: [Int32] = []
        defer { for fd in fillers { Darwin.close(fd) } }
        for _ in 0..<32 {
            let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
            guard fd >= 0 else { throw RecorderControlError.system(errno) }
            fillers.append(fd)
            _ = fcntl(fd, F_SETFL, O_NONBLOCK)
            _ = Self.connect(fd, path: path)
        }
        let began = Date()
        do {
            _ = try await call("status")
            XCTFail("A saturated listener must not produce a successful response")
        } catch { XCTAssertTrue(error is RecorderControlError) }
        XCTAssertLessThan(Date().timeIntervalSince(began), 4.5)
    }

    @MainActor func testSuccessfulResponseInvokesDeliveryCallback() async throws {
        let delivered = Happened()
        let server = try RecorderControlServer(directory: root, didRespond: { response in
            XCTAssertEqual(response.state, "shutting_down")
            delivered.note()
        }) { _ in ControlResponse(ok: true, state: "shutting_down") }
        defer { server.close() }
        let response = try await call("shutdown")
        XCTAssertEqual(response.state, "shutting_down")
        try await until("delivered.value") { delivered.value }
    }

    @MainActor func testAsyncHandlerKeepsLifecycleCommandsOrderedWithoutBlockingMainActor() async throws {
        var resumePause: CheckedContinuation<Void, Never>?
        let entered = Happened()
        var actions: [String] = []
        let server = try RecorderControlServer(directory: root) { request in
            actions.append(request.action)
            if request.action == "pause" {
                await withCheckedContinuation {
                    resumePause = $0
                    entered.note()
                }
            }
            return ControlResponse(ok: true, state: request.action)
        }
        defer { server.close() }
        let pause = Task { try await call("pause") }
        try await until("entered.value") { entered.value }
        let following = Task { try await call("start") }
        await Task.yield()
        XCTAssertEqual(actions, ["pause"])
        resumePause?.resume()
        let pauseResult = try await pause.value
        let nextResult = try await following.value
        XCTAssertEqual(pauseResult.state, "pause")
        XCTAssertEqual(nextResult.state, "start")
        XCTAssertEqual(actions, ["pause", "start"])
    }

    @MainActor func testClosingWhileAsyncHandlerIsSuspendedDoesNotDeadlockOrOverResumeSource() async throws {
        var resume: CheckedContinuation<Void, Never>?
        let entered = Happened()
        let server = try RecorderControlServer(directory: root) { _ in
            await withCheckedContinuation {
                resume = $0
                entered.note()
            }
            return ControlResponse(ok: true, state: "stopped")
        }
        defer { server.close() }
        let pending = Task { try await call("pause") }
        try await until("entered.value") { entered.value }
        server.close()
        server.close()
        resume?.resume()
        let response = try await pending.value
        XCTAssertTrue(response.ok)
    }

    private func rawRequest(path: String, data: Data) async throws -> ControlResponse {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(with: Result {
                    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
                    guard fd >= 0 else { throw RecorderControlError.system(errno) }
                    defer { Darwin.close(fd) }
                    guard Self.connect(fd, path: path) == 0 else { throw RecorderControlError.unavailable }
                    var timeout = timeval(tv_sec: 4, tv_usec: 0)
                    _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
                    var enabled: Int32 = 1
                    _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size))
                    _ = data.withUnsafeBytes { Darwin.send(fd, $0.baseAddress, $0.count, 0) }
                    var response = Data()
                    var buffer = [UInt8](repeating: 0, count: 1024)
                    while !response.contains(10) {
                        let size = Darwin.recv(fd, &buffer, buffer.count, 0)
                        guard size > 0 else { throw RecorderControlError.invalidResponse }
                        response.append(contentsOf: buffer.prefix(size))
                    }
                    return try JSONDecoder().decode(ControlResponse.self, from: response)
                })
            }
        }
    }

    private func call(_ action: String, durationSeconds: Double? = nil) async throws -> ControlResponse {
        let request = ControlRequest(action: action, durationSeconds: durationSeconds)
        return try await RecorderControlClient.call(directory: root, request: request)
    }

    private static func bind(_ fd: Int32, path: String) -> Int32 {
        withAddress(path) { Darwin.bind(fd, $0, $1) }
    }

    private static func connect(_ fd: Int32, path: String) -> Int32 {
        withAddress(path) { Darwin.connect(fd, $0, $1) }
    }

    private static func withAddress(_ path: String,
                                    _ operation: (UnsafePointer<sockaddr>, socklen_t) -> Int32) -> Int32 {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: Array(path.utf8) + [0]) }
        return withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                operation($0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
    }
}
