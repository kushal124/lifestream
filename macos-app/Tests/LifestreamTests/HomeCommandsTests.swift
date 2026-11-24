import Foundation
import Recorder
import XCTest
@testable import Lifestream

@MainActor
final class HomeCommandsTests: XCTestCase {
    final class Asked: @unchecked Sendable {
        private let lock = NSLock()
        private var requests: [ControlRequest] = []
        var made: [ControlRequest] { lock.withLock { requests } }
        func add(_ request: ControlRequest) { lock.withLock { requests.append(request) } }
    }

    private var root: URL!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: "/tmp", isDirectory: true).appendingPathComponent("hc-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
    }

    private func pairing() throws -> Options {
        try Options(["home", "--store", root.path, "--name", "home-a", "--code", "12345678"])
    }

    func testWithTheAppRunningTheCommandPairsInTheAppAndSaysItsAnswer() async throws {
        let asked = Asked()
        let line = ControlHome(home: "https://home-a.example.com/", pass: "set", unit: "macbook-pro-0001")
        let server = try RecorderControlServer(directory: root) { request in
            asked.add(request)
            return ControlResponse(ok: true, state: "paired", home: line)
        }
        defer { server.close() }
        let outcome = try await HomeCommands.home(try pairing())
        XCTAssertEqual(outcome, .succeeded)
        XCTAssertEqual(asked.made.map(\.action), ["pair"])
        XCTAssertEqual(asked.made.first?.name, "home-a")
        XCTAssertEqual(asked.made.first?.code, "12345678")
    }

    func testTheAppsRefusalIsTheCommandsFailureWithItsWords() async throws {
        let words = "This Mac already holds recordings. Uninstall Lifestream on this Mac, keeping your Lifestream data, "
            + "then set it up again. Uninstall deletes what this Mac recorded and has not sent."
        let server = try RecorderControlServer(directory: root) { _ in ControlResponse(ok: false, state: "error", message: words) }
        defer { server.close() }
        do {
            _ = try await HomeCommands.home(try pairing())
            XCTFail("a refused pairing succeeded")
        } catch let error as UsageError {
            XCTAssertEqual(error.localizedDescription, words)
        }
    }

    func testWithNoAppRunningTheCommandPairsNothingAndSaysToOpenLifestream() async throws {
        do {
            _ = try await HomeCommands.home(try pairing())
            XCTFail("a command paired this Mac with no app running")
        } catch let error as UsageError {
            XCTAssertEqual(error.localizedDescription, HomeCommands.appClosedWords)
        }
    }

    func testAPairRequestCarriesANameAndACodeAndNoOtherRequestDoes() async throws {
        let server = try RecorderControlServer(directory: root) { _ in ControlResponse(ok: true, state: "paired") }
        defer { server.close() }
        for request in [ControlRequest(action: "pair", name: "home-a"), ControlRequest(action: "pair", code: "12345678"),
                        ControlRequest(action: "status", name: "home-a", code: "12345678"),
                        ControlRequest(action: "modes", code: "12345678")] {
            do {
                _ = try await RecorderControlClient.call(directory: root, request: request)
                XCTFail("\(request.action) with name \(request.name ?? "none") and code \(request.code ?? "none") was sent")
            } catch RecorderControlError.invalidRequest {}
        }
    }

    func testThePairResponseCarriesTheHomeLineAsTheCommandPrintsIt() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let set = ControlHome(home: "https://home-a.example.com/", pass: "set", unit: "macbook-pro-0001")
        XCTAssertEqual(String(decoding: try encoder.encode(set), as: UTF8.self),
                       #"{"home":"https:\/\/home-a.example.com\/","pass":"set","unit":"macbook-pro-0001"}"#)
        XCTAssertEqual(String(decoding: try encoder.encode(ControlHome(home: nil, pass: "unset", unit: nil)), as: UTF8.self),
                       #"{"home":null,"pass":"unset","unit":null}"#)
        let carried = try JSONDecoder().decode(ControlResponse.self, from: try encoder.encode(ControlResponse(ok: true, state: "paired", home: set)))
        XCTAssertEqual(carried.home, set)
    }
}
