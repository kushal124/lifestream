import DeviceFiles
import Foundation
import HomeLink
import XCTest
@testable import Lifestream

final class ReachDiagnosisTests: XCTestCase {
    private var root: URL!
    private let local = URL(string: "http://127.0.0.1:4680")
    private let remote = URL(string: "https://home-0001.example.com")

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("reach-diagnosis-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var noPointer: URL { root.appendingPathComponent("no-pointer") }

    private func cause(_ lines: [String]) throws -> HomeLink.Cause? {
        let log = root.appendingPathComponent("home.log")
        try Data((lines.joined(separator: "\n") + "\n").utf8).write(to: log)
        return ReachDiagnosis.cause(home: local, pointer: noPointer, log: log)
    }

    func testTheLastLineNamesAStorageErrorInWords() throws {
        let started = #"{"home":"started","version":"0.2.0"}"#
        XCTAssertEqual(try cause([started, #"{"storage":"failed","error":"SQLITE_FULL"}"#,
                                  #"{"home":"stopped","why":"storage: SQLITE_FULL: database or disk is full"}"#]),
                       .local("The disk holding Lifestream is full. Free some room and it starts again."))
        XCTAssertEqual(try cause([#"{"home":"stopped","why":"storage: SQLITE_CORRUPT: database disk image is malformed"}"#]),
                       .local("Lifestream on this Mac stopped: storage: SQLITE_CORRUPT: database disk image is malformed"))
        XCTAssertEqual(try cause([#"{"home":"failed","why":"storage: SQLITE_IOERR: disk I/O error"}"#]),
                       .local("The drive holding Lifestream could not be read. Lifestream tries again within a minute."))
        XCTAssertEqual(try cause([#"{"home":"failed","why":"the release is missing"}"#]),
                       .local("Lifestream on this Mac stopped: the release is missing"))
    }

    func testAnyOtherLastLineIsTheSocketsToSay() throws {
        XCTAssertEqual(try cause([#"{"job":"plan","key":"messages","failed":"boom","now":"queued"}"#]), .notRunning)
        XCTAssertEqual(try cause(["not json"]), .notRunning)
        let missing = root.appendingPathComponent("missing.log")
        XCTAssertEqual(ReachDiagnosis.cause(home: local, pointer: noPointer, log: missing), .notRunning, "no pointer, no socket")

        let machine = "/tmp/lsr-\(UUID().uuidString.prefix(8))"
        defer { try? FileManager.default.removeItem(atPath: machine) }
        let (pointer, _, path) = try SocketMachine.make(machine)
        XCTAssertEqual(ReachDiagnosis.cause(home: local, pointer: pointer, log: missing), .notRunning, "no socket file")
        let listener = try Self.listen(at: path)
        XCTAssertNil(ReachDiagnosis.cause(home: local, pointer: pointer, log: missing), "a socket that takes a connection is no cause")
        Darwin.close(listener)
        XCTAssertEqual(ReachDiagnosis.cause(home: local, pointer: pointer, log: missing), .notRunning, "a socket file that refuses")
    }

    private static func listen(at path: String) throws -> Int32 {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8) + [0]
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0, Darwin.listen(fd, 8) == 0 else { throw POSIXError(.EADDRINUSE) }
        return fd
    }

    func testADriveThatIsNotMountedIsSaidFirst() throws {
        let pointer = root.appendingPathComponent("pointer")
        try Data("/Volumes/Synthetic-0001/Lifestream\n".utf8).write(to: pointer)
        let log = root.appendingPathComponent("home.log")
        try Data(#"{"home":"stopped","why":"storage: SQLITE_IOERR: disk I/O error"}"#.utf8).write(to: log)
        XCTAssertEqual(ReachDiagnosis.cause(home: local, pointer: pointer, log: log),
                       .driveAway)
        XCTAssertNil(ReachDiagnosis.cause(home: remote, pointer: pointer, log: log), "a home on another machine")
        XCTAssertNil(ReachDiagnosis.cause(home: nil, pointer: pointer, log: log), "no home")
    }

    func testOnlyTheLastLineOfALongLogIsRead() throws {
        let filler = Array(repeating: #"{"job":"render","key":"2026-09-23","failed":"synthetic"}"#, count: 2_000)
        XCTAssertEqual(try cause(filler + [#"{"home":"stopped","why":"storage: SQLITE_CANTOPEN: unable to open"}"#]),
                       .local("The drive holding Lifestream could not be read. Lifestream tries again within a minute."))
    }

    func testTheExplainReadsTheHomeTheLinkIsPairedWith() throws {
        let stored = try JSONSerialization.data(withJSONObject: ["name": "http://127.0.0.1:4680", "pass": "fake-pass-000000000000",
                                                                 "paired": true, "unit": "macbook-pro-0001"])
        let link = HomeLink(device: .init(kind: .mac, version: "500", model: "Mac15,3", serial4: nil), credentials: StoredPass(stored),
                            folder: root.appendingPathComponent("link"), transport: StandInDoor(), files: DeviceFiles(.plain))
        let missing = root.appendingPathComponent("missing.log")
        XCTAssertEqual(ReachDiagnosis.explain(link, pointer: noPointer, log: missing)(), .notRunning)
        let unpaired = HomeLink(device: .init(kind: .mac, version: "500", model: "Mac15,3", serial4: nil), credentials: StoredPass(nil),
                                folder: root.appendingPathComponent("unpaired"), transport: StandInDoor(), files: DeviceFiles(.plain))
        XCTAssertNil(ReachDiagnosis.explain(unpaired, pointer: noPointer, log: missing)())
    }
}
