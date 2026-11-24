import DeviceFiles
import Recorder
import XCTest
@testable import Lifestream

final class OffAndHoldTests: XCTestCase {
    func testARecorderTheAnswerLeavesOutIsOff() {
        let all = ["screen:local:macbook-pro-0001", "input:local:macbook-pro-0001", "audio:local:macbook-pro-0001",
                   "machine:local:macbook-pro-0001", "imessage:person-a@example.com:macbook-pro-0001"]
        XCTAssertEqual(RecordingSwitches.off(all), [])
        XCTAssertEqual(RecordingSwitches.off(all.filter { !$0.hasPrefix("screen:") && !$0.hasPrefix("audio:") }), [.screen, .audio])
        XCTAssertEqual(RecordingSwitches.off(nil), [], "not paired: no home says anything is off")
        XCTAssertEqual(RecordingSwitches.off(["imessage:person-a@example.com:macbook-pro-0001"]), [.screen, .input, .audio])
    }

    private func folder(_ audio: String?) throws -> (URL, URL) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("carry-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent(AudioCarry.fileName)
        if let audio { try Data(audio.utf8).write(to: file) }
        return (folder, file)
    }

    private let audio = "audio:local:macbook-pro-0001"
    private let sources = ["screen:local:macbook-pro-0001", "input:local:macbook-pro-0001", "audio:local:macbook-pro-0001", "imessage:person-a@example.com:macbook-pro-0001"]

    @MainActor private final class Run {
        var now = Date(timeIntervalSince1970: 0)
        var sent: [String] = []
        var knocks = 0
        var refuse = false
        let carry: AudioCarry

        init(_ folder: URL) {
            var clock: (() -> Date)!
            carry = AudioCarry(directory: folder, files: DeviceFiles(.plain), clock: { clock() })
            clock = { [unowned self] in self.now }
        }

        func hear(at second: Double, asked: Double?) async {
            await carry.answered(at: Self.at(second), asked: asked.map(Self.at), audio: "audio:local:macbook-pro-0001", turn: { [unowned self] in
                self.sent.append($0)
                if self.refuse { throw HostRefusal(.notSent) }
            }, knock: { [unowned self] in self.knocks += 1 })?.value
        }

        static func at(_ second: Double) -> Date { Date(timeIntervalSince1970: second) }
    }

    @MainActor func testAStaleExchangeKeepsTheHoldAndThePostTurnOneCompletesIt() async throws {
        let (folder, file) = try folder(#"{"record":false}"#)
        let run = Run(folder)
        XCTAssertEqual(RecordingSwitches.off(sources).union(run.carry.off), [.audio])
        run.now = Run.at(10)
        await run.hear(at: -60, asked: nil)
        XCTAssertEqual(run.sent, [audio])
        XCTAssertEqual(run.knocks, 1)
        XCTAssertTrue(run.carry.pending, "the verb's return lifted the hold")
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        await run.hear(at: 12, asked: 8)
        XCTAssertTrue(run.carry.pending, "a stale exchange lifted the hold")
        XCTAssertEqual(RecordingSwitches.off(sources).union(run.carry.off), [.audio])
        XCTAssertEqual(run.sent.count, 1)
        await run.hear(at: 14, asked: 11)
        XCTAssertFalse(run.carry.pending)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        XCTAssertEqual(run.carry.off, [])
        XCTAssertEqual(AudioCarry(directory: folder, files: DeviceFiles(.plain)).off, [], "the next launch holds it off again")
    }

    @MainActor func testAudioTurnedOnAtTheHomeAfterTheCarryIsNeverTurnedOff() async throws {
        let (folder, _) = try folder(#"{"record":false}"#)
        let run = Run(folder)
        run.now = Run.at(10)
        await run.hear(at: 5, asked: 4)
        await run.hear(at: 12, asked: 11)
        XCTAssertFalse(run.carry.pending)
        for second in [20.0, 30, 40] { await run.hear(at: second, asked: second - 1) }
        XCTAssertEqual(run.sent.count, 1)
        XCTAssertEqual(RecordingSwitches.off(sources).union(run.carry.off), [], "Audio held off after the person turned it on")
    }

    @MainActor func testTheSameAnswerProjectedTwiceSendsOneTurn() async throws {
        let (folder, _) = try folder(#"{"record":false}"#)
        let run = Run(folder)
        run.refuse = true
        await run.hear(at: 5, asked: 4)
        await run.hear(at: 5, asked: 4)
        XCTAssertEqual(run.sent.count, 1, "the same answer read again sent the turn again")
        run.refuse = false
        let first = run.carry.answered(at: Run.at(6), asked: Run.at(4), audio: audio, turn: { _ in }, knock: {})
        XCTAssertNil(run.carry.answered(at: Run.at(7), asked: Run.at(4), audio: audio, turn: { _ in XCTFail("two turns in flight") }, knock: {}))
        await first?.value
        XCTAssertTrue(run.carry.pending)
    }

    @MainActor func testAFailedKnockSendsNoSecondTurn() async throws {
        let (folder, file) = try folder(#"{"record":false}"#)
        let run = Run(folder)
        run.now = Run.at(10)
        await run.hear(at: 5, asked: 4)
        XCTAssertEqual(run.knocks, 1)
        await run.hear(at: 5, asked: 4)
        await run.hear(at: 9.5, asked: 9)
        XCTAssertEqual(run.sent.count, 1, "a failed knock sent the turn again")
        XCTAssertEqual(run.knocks, 1)
        XCTAssertTrue(run.carry.pending)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
    }

    @MainActor func testARelaunchMidCarryTurnsAgainAndCompletesOnAnAnswerNamingNoLocalSource() async throws {
        let (folder, file) = try folder(#"{"record":false}"#)
        let run = Run(folder)
        XCTAssertEqual(run.carry.off, [.audio])
        run.now = Run.at(100)
        await run.hear(at: 50, asked: nil)
        XCTAssertEqual(run.sent, [audio], "the relaunch never sent the turn again")
        await run.hear(at: 102, asked: 101)
        XCTAssertFalse(run.carry.pending)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        XCTAssertEqual(RecordingSwitches.off(["imessage:person-a@example.com:macbook-pro-0001"]).union(run.carry.off),
                       [.screen, .input, .audio], "off as the home says")
    }

    @MainActor func testAFileThatWouldNotGoKeepsTheHoldAndGoesAtALaterAnswer() async throws {
        let (folder, file) = try folder(#"{"record":false}"#)
        let run = Run(folder)
        run.now = Run.at(10)
        await run.hear(at: 5, asked: 4)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: folder.path)
        addTeardownBlock { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder.path) }
        await run.hear(at: 12, asked: 11)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        XCTAssertTrue(run.carry.pending, "complete with the file still there")
        XCTAssertEqual(RecordingSwitches.off(sources).union(run.carry.off), [.audio])
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder.path)
        await run.hear(at: 14, asked: 13)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        XCTAssertFalse(run.carry.pending)
        XCTAssertEqual(run.sent.count, 1)
        XCTAssertEqual(run.knocks, 1)
    }

    @MainActor func testAFileThatSaysOnGoesAtOnceAndNothingIsSent() async throws {
        for said in [#"{"record":true}"#, "not json", nil] {
            let (folder, file) = try folder(said)
            let carry = AudioCarry(directory: folder, files: DeviceFiles(.plain))
            XCTAssertFalse(FileManager.default.fileExists(atPath: file.path), "\(said ?? "none")")
            XCTAssertEqual(carry.off, [])
            XCTAssertNil(carry.answered(at: Date(), asked: Date(), audio: audio, turn: { _ in XCTFail("sent an off for \(said ?? "none")") }, knock: {}))
        }
    }
}
