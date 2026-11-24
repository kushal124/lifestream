import Foundation
import XCTest
@testable import Evidence

final class DayFilesTests: XCTestCase {
    private var folder: URL!
    private let now = Date(timeIntervalSince1970: 1_699_963_200)

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("day-files-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("powerlog"), withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: folder) }

    private func make(_ names: [String]) throws {
        for name in names { try Data("{}\n".utf8).write(to: folder.appendingPathComponent(name)) }
    }
    private func names(_ sub: String = "") throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: folder.appendingPathComponent(sub).path).sorted()
    }

    func testANameIsItsUTCDay() {
        XCTAssertEqual(DayFiles.name("app-", at: Date(timeIntervalSince1970: 1_700_006_399.999)), "app-2023-11-14.jsonl")
        XCTAssertEqual(DayFiles.name("app-", at: Date(timeIntervalSince1970: 1_700_006_400)), "app-2023-11-15.jsonl")
    }

    func testAFileOlderThanItsDaysGoesAndTheRestStay() throws {
        try make(["app-2023-10-14.jsonl", "app-2023-10-15.jsonl", "app-2023-10-16.jsonl", "app-2023-11-14.jsonl",
                  "app-2023-1-01.jsonl", "app-2023-02-30.jsonl", "app-old.jsonl", "app-2023-10-01.json",
                  "watch-2023-10-01.jsonl"])
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("app-2023-09-01.jsonl"),
                                                withIntermediateDirectories: false)
        XCTAssertEqual(DayFiles.prune(in: folder, prefix: "app-", keepDays: 30, now: now), 1)
        XCTAssertEqual(try names(), ["app-2023-02-30.jsonl", "app-2023-09-01.jsonl", "app-2023-1-01.jsonl",
                                     "app-2023-10-01.json", "app-2023-10-15.jsonl", "app-2023-10-16.jsonl",
                                     "app-2023-11-14.jsonl", "app-old.jsonl", "powerlog", "watch-2023-10-01.jsonl"])
    }

    func testAPrefixMayNameASubfolder() throws {
        try make(["powerlog/battery-2023-10-01.jsonl", "powerlog/battery-2023-11-01.jsonl",
                  "powerlog/coalitions-2023-10-01.jsonl", "powerlog/cursor.json", "battery-2023-10-01.jsonl"])
        XCTAssertEqual(DayFiles.prune(in: folder, prefix: "powerlog/battery-", keepDays: 30, now: now), 1)
        XCTAssertEqual(try names("powerlog"), ["battery-2023-11-01.jsonl", "coalitions-2023-10-01.jsonl", "cursor.json"])
        XCTAssertTrue(try names().contains("battery-2023-10-01.jsonl"))
    }

    func testAPrunerPrunesAtTheFirstWriteOfEachDay() throws {
        let pruner = DayFiles.Pruner(in: folder, prefixes: ["app-", "powerlog/battery-"])
        try make(["app-2023-10-13.jsonl", "powerlog/battery-2023-10-13.jsonl", "watch-2023-10-13.jsonl"])
        XCTAssertEqual(pruner.prune(at: now), 2)
        try make(["app-2023-10-12.jsonl"])
        XCTAssertEqual(pruner.prune(at: now.addingTimeInterval(3_600)), 0, "the day was pruned already")
        XCTAssertTrue(try names().contains("app-2023-10-12.jsonl"))
        XCTAssertEqual(pruner.prune(at: now.addingTimeInterval(86_400)), 1, "the next day prunes again")
        XCTAssertEqual(try names(), ["powerlog", "watch-2023-10-13.jsonl"])
        XCTAssertEqual(DayFiles.keepDays, 30)
    }

    func testAMissingFolderPrunesNothing() {
        XCTAssertEqual(DayFiles.prune(in: folder.appendingPathComponent("absent"), prefix: "app-", keepDays: 30, now: now), 0)
    }
}
