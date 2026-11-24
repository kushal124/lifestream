import Foundation
import DeviceFiles
import XCTest
@testable import Evidence

final class FailureLinesTests: XCTestCase {
    private var spool: URL!
    private let at = Date(timeIntervalSince1970: 1_700_000_000.25)
    private let since = Date(timeIntervalSince1970: 1_699_999_000)

    override func setUpWithError() throws {
        spool = FileManager.default.temporaryDirectory.appendingPathComponent("failure-lines-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: spool, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: spool) }

    private func lines(_ day: String = "2023-11-14") throws -> [String] {
        let file = spool.appendingPathComponent("resources/recorder-\(day).jsonl")
        return try String(decoding: Data(contentsOf: file), as: UTF8.self).split(separator: "\n").map(String.init)
    }

    func testEachMemberShapeIsPinned() throws {
        let lines = FailureLines()
        lines.configure(spool: spool, plain: DeviceFiles(.plain), build: "4805 \"main\"", pid: 777)
        lines.note(.runStarted, at: at)
        lines.note(.tenureLost, kind: "io", errno: 28, at: at)
        lines.note(.segmentSetAside, kind: "format", at: at)
        lines.note(.helperBack, since: since, at: at)
        lines.note(.tenureOpened, kind: "io", errno: 28, since: since, at: at)
        lines.note(.minutesWritten, errno: 5, since: since, at: at)
        lines.drain()
        let head = #"{"at":"2023-11-14T22:13:20.250Z","build":"4805 \"main\"","pid":777"#
        XCTAssertEqual(try self.lines(), [
            head + #","part":"recorder","event":"run_started"}"#,
            head + #","part":"recorder","event":"tenure_lost","kind":"io","errno":28}"#,
            head + #","part":"spool","event":"segment_set_aside","kind":"format"}"#,
            head + #","part":"recognition","event":"helper_back","since":"2023-11-14T21:56:40.000Z"}"#,
            head + #","part":"recorder","event":"tenure_opened","kind":"io","errno":28,"since":"2023-11-14T21:56:40.000Z"}"#,
            head + #","part":"input_log","event":"minutes_written","errno":5,"since":"2023-11-14T21:56:40.000Z"}"#,
        ])
    }

    func testEveryEventNamesItsPart() {
        let parts = Dictionary(grouping: FailureLines.Event.allCases, by: \.part)
        XCTAssertEqual(parts[.machineEvents], [.lineDropped, .linesWritten])
        XCTAssertEqual(parts[.inputLog], [.minuteDropped, .minutesWritten])
        XCTAssertEqual(parts[.recognition], [.helperUnavailable, .helperBack])
        XCTAssertEqual(parts[.spool], [.compactionFailing, .compactionRecovered, .segmentSetAside])
        XCTAssertEqual(parts[.recorder]?.count, 9)
    }

    func testALineGoesInTheFileOfItsUTCDay() throws {
        let lines = FailureLines()
        lines.configure(spool: spool, plain: DeviceFiles(.plain), build: "b", pid: 1)
        lines.note(.runEnded, at: Date(timeIntervalSince1970: 1_700_006_399.999))
        lines.note(.runStarted, at: Date(timeIntervalSince1970: 1_700_006_400))
        lines.drain()
        XCTAssertEqual(try self.lines("2023-11-14").count, 1)
        XCTAssertEqual(try self.lines("2023-11-15").count, 1)
    }

    func testTheFirstLineOfADayPrunesFilesOlderThanThirtyDays() throws {
        let resources = spool.appendingPathComponent("resources")
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        for name in ["recorder-2023-10-13.jsonl", "recorder-2023-10-15.jsonl", "app-2023-10-13.jsonl"] {
            try Data("{}\n".utf8).write(to: resources.appendingPathComponent(name))
        }
        let lines = FailureLines()
        lines.configure(spool: spool, plain: DeviceFiles(.plain), build: "b", pid: 1)
        lines.note(.runStarted, at: at)
        lines.drain()
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: resources.path).sorted(),
                       ["app-2023-10-13.jsonl", "recorder-2023-10-15.jsonl", "recorder-2023-11-14.jsonl"])
    }

    func testAFolderThatCannotBeWrittenLosesTheLineAndThrowsNothing() throws {
        try Data("not a folder".utf8).write(to: spool.appendingPathComponent("resources"))
        let lines = FailureLines()
        lines.configure(spool: spool, plain: DeviceFiles(.plain), build: "b", pid: 1)
        lines.note(.tenureLost, kind: "io", errno: 28, at: at)
        lines.drain()
        try FileManager.default.removeItem(at: spool.appendingPathComponent("resources"))
        lines.note(.tenureOpened, kind: "io", errno: 28, since: since, at: at)
        lines.drain()
        XCTAssertEqual(try self.lines().count, 1, "the lost line is gone; the next one lands")
        XCTAssertTrue(try self.lines()[0].contains(#""event":"tenure_opened""#))
    }

    func testNothingIsWrittenBeforeConfiguration() {
        let lines = FailureLines()
        lines.note(.runStarted, at: at)
        lines.drain()
        XCTAssertFalse(FileManager.default.fileExists(atPath: spool.appendingPathComponent("resources").path))
    }

    func testAStreakNotesItsFirstFailureAndItsEndWithTheCause() throws {
        let lines = FailureLines()
        lines.configure(spool: spool, plain: DeviceFiles(.plain), build: "b", pid: 1)
        var streak = FailureLines.Streak(closing: .tenureOpened)
        streak.ended(at: at, lines: lines)
        for attempt in 0..<50 {
            streak.failed(attempt == 0 ? .tenureLost : .openingFailed, kind: "io", errno: attempt == 0 ? 28 : 5,
                          at: since.addingTimeInterval(Double(attempt)), lines: lines)
        }
        XCTAssertTrue(streak.isOpen)
        streak.ended(at: at, lines: lines)
        streak.ended(at: at, lines: lines)
        XCTAssertFalse(streak.isOpen)
        lines.drain()
        let written = try self.lines()
        XCTAssertEqual(written.count, 2)
        XCTAssertTrue(written[0].hasSuffix(#""event":"tenure_lost","kind":"io","errno":28}"#))
        XCTAssertTrue(written[1].hasSuffix(#""event":"tenure_opened","kind":"io","errno":28,"since":"2023-11-14T21:56:40.000Z"}"#))
    }
}
