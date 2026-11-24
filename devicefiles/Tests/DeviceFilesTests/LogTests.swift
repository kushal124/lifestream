import CryptoKit
import Foundation
import XCTest
@testable import DeviceFiles

final class LogTests: FilesTestCase {
    private let keyed = DeviceFiles(.keyed(testKey))

    private func written(_ lines: [String]) throws -> URL {
        let url = file("events")
        let log = try keyed.log(url)
        for line in lines { try log.append(Data(line.utf8), flush: nil) }
        log.close()
        return url
    }

    private func records(_ disk: Data) -> [Data] {
        var parts: [Data] = []
        var at = LogLayout.headerBytes
        while at < disk.count {
            let length = Int(disk.subdata(in: at..<(at + 4)).reduce(UInt32(0)) { $0 << 8 | UInt32($1) })
            parts.append(disk.subdata(in: at..<(at + 4 + length)))
            at += 4 + length
        }
        return parts
    }

    private func refused(_ disk: Data, _ what: String) throws {
        let url = file(what)
        try disk.write(to: url)
        XCTAssertThrowsError(try keyed.read(url, maximumBytes: 10_000), what) {
            guard case .unreadable = $0 as? DeviceFileError else { return XCTFail("\(what): \($0)") }
        }
    }

    func testEachRecordIsOneBoxBehindAHeader() throws {
        let url = try written(["A\n", "BB\n"])
        let disk = try raw(url)
        XCTAssertEqual(disk.first, 0x80)
        XCTAssertEqual(disk.count, LogLayout.headerBytes + 2 * LogLayout.overhead + 5)
        XCTAssertEqual(try keyed.read(url, maximumBytes: 100), Data("A\nBB\n".utf8))
        XCTAssertEqual(try keyed.size(of: url), 5)
    }

    func testATornTailIsDroppedByReadAndCutByTheNextOwner() throws {
        let url = try written(["A\n", "B\n"])
        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data([0, 0, 0, 40, 9, 9, 9]))
        try handle.close()
        XCTAssertEqual(try keyed.read(url, maximumBytes: 100), Data("A\nB\n".utf8))
        XCTAssertEqual(try keyed.size(of: url), 4)
        let log = try keyed.log(url)
        XCTAssertTrue(log.damaged)
        try log.append(Data("C\n".utf8), flush: .full)
        XCTAssertFalse(log.damaged)
        XCTAssertEqual(try keyed.read(url, maximumBytes: 100), Data("A\nB\nC\n".utf8))
        XCTAssertEqual(try raw(url).count, LogLayout.headerBytes + 3 * (LogLayout.overhead + 2))
    }

    func testARecordMovedRepeatedOrDroppedIsRefused() throws {
        let disk = try raw(try written(["A\n", "B\n", "C\n"]))
        let header = disk.prefix(LogLayout.headerBytes)
        let parts = records(disk)
        XCTAssertEqual(parts.count, 3)
        try refused(header + parts[1] + parts[0] + parts[2], "moved")
        try refused(header + parts[0] + parts[1] + parts[2] + parts[2], "repeated")
        try refused(header + parts[0] + parts[2], "dropped")
        var flipped = disk
        flipped[flipped.count - 1] ^= 1
        try refused(flipped, "flipped")
        var salt = disk
        salt[3] ^= 1
        try refused(salt, "salt")
    }

    func testAKeyedLogWithNoRecordsIsSizeZero() throws {
        let url = file("events")
        _ = try keyed.log(url)
        XCTAssertEqual(try raw(url).count, LogLayout.headerBytes)
        XCTAssertEqual(try keyed.size(of: url), 0)
        XCTAssertThrowsError(try keyed.read(url, maximumBytes: 100)) {
            XCTAssertEqual($0 as? DeviceFileError, .invalidSizeOrType(name: "events", maximumBytes: 100))
        }
    }

    func testTruncateStartsAKeyedLogAgainUnderAFreshSalt() throws {
        let url = file("events")
        let log = try keyed.log(url)
        try log.append(Data("A\n".utf8), flush: nil)
        let before = try raw(url).prefix(LogLayout.headerBytes)
        try log.truncate()
        XCTAssertEqual(try keyed.size(of: url), 0)
        XCTAssertNotEqual(try raw(url).prefix(LogLayout.headerBytes), before)
        try log.append(Data("B\n".utf8), flush: nil)
        XCTAssertEqual(try keyed.read(url, maximumBytes: 100), Data("B\n".utf8))
    }

    func testALogOpenedPlainFollowsTheSwitchIntoANewKeyedFile() throws {
        let files = DeviceFiles(.plain)
        let url = file("current.jsonl")
        let log = try files.log(url)
        try log.append(Data("A\n".utf8), flush: .full)
        XCTAssertEqual(try raw(url), Data("A\n".utf8))
        try files.becomeKeyed(testKey) { _ in
            try FileManager.default.removeItem(at: url)
        }
        try log.append(Data("B\n".utf8), flush: .full)
        XCTAssertEqual(try raw(url).first, 0x80)
        XCTAssertEqual(try files.read(url, maximumBytes: 100), Data("B\n".utf8))
        XCTAssertEqual(try keyed.read(url, maximumBytes: 100), Data("B\n".utf8))
    }

    func testAPlainFileWhereAKeyedLogShouldBeIsRefused() throws {
        for count in [1, 2, LogLayout.headerBytes - 1, LogLayout.headerBytes, 200] {
            let url = file("events-\(count)")
            let plain = Data(repeating: UInt8(ascii: "A"), count: count - 1) + Data("\n".utf8)
            try plain.write(to: url)
            XCTAssertThrowsError(try keyed.log(url), "\(count)") {
                guard case .unreadable = $0 as? DeviceFileError else { return XCTFail("\(count): \($0)") }
            }
            XCTAssertEqual(try raw(url), plain, "\(count)")
        }
    }

    func testAHeaderCutShortIsStartedAgain() throws {
        let url = file("events")
        try (LogLayout.header().prefix(LogLayout.headerBytes - 5)).write(to: url)
        let log = try keyed.log(url)
        try log.append(Data("A\n".utf8), flush: nil)
        XCTAssertEqual(try keyed.read(url, maximumBytes: 100), Data("A\n".utf8))
    }

    func testAMidLogLengthOverTheBoundIsDamageNeverCut() throws {
        let url = try written(["A\n", "B\n", "C\n"])
        var disk = try raw(url)
        let second = LogLayout.headerBytes + LogLayout.overhead + 2
        disk.replaceSubrange(second..<(second + 4), with: [0x7f, 0xff, 0xff, 0xff])
        try disk.write(to: url)
        XCTAssertThrowsError(try keyed.read(url, maximumBytes: 100)) {
            guard case .unreadable = $0 as? DeviceFileError else { return XCTFail("\($0)") }
        }
        XCTAssertThrowsError(try keyed.size(of: url))
        XCTAssertThrowsError(try keyed.log(url)) {
            guard case .unreadable = $0 as? DeviceFileError else { return XCTFail("\($0)") }
        }
        XCTAssertEqual(try raw(url), disk)
    }

    func testAnAppendOverTheBoundIsRefusedInBothForms() throws {
        for (form, files) in forms() {
            let url = file("events", form)
            let log = try files.log(url)
            let before = try raw(url)
            XCTAssertThrowsError(try log.append(Data(count: LogLayout.maximumRecord + 1), flush: nil), form) {
                XCTAssertEqual($0 as? DeviceFileError, .invalidSizeOrType(name: url.lastPathComponent, maximumBytes: LogLayout.maximumRecord), form)
            }
            XCTAssertEqual(try raw(url), before, form)
        }
    }

    func testAFailedTruncateLeavesNoOldKeyOverAHeaderlessFile() throws {
        let url = file("events")
        let log = try keyed.log(url)
        try log.append(Data("A\n".utf8), flush: nil)
        DeviceFiles.writeLimit = 0
        XCTAssertThrowsError(try log.truncate())
        DeviceFiles.writeLimit = nil
        XCTAssertEqual(try raw(url).count, 0)
        try log.append(Data("B\n".utf8), flush: nil)
        XCTAssertEqual(try raw(url).first, LogLayout.mark)
        XCTAssertEqual(try keyed.read(url, maximumBytes: 100), Data("B\n".utf8))
    }

    func testAPlainCutKeepsThePlainBytesAskedBehindABarrier() throws {
        let files = DeviceFiles(.plain)
        let url = file("current.jsonl")
        let log = try files.log(url)
        for line in ["A\n", "BB\n", "CCC"] { try log.append(Data(line.utf8), flush: nil) }
        var flushed: [DeviceFiles.Flush] = []
        DeviceFiles.flushObserver = { seen, flush in if seen == url { flushed.append(flush) } }
        try log.cut(keepingPlainBytes: 5)
        DeviceFiles.flushObserver = nil
        XCTAssertEqual(flushed, [.barrier])
        XCTAssertEqual(try files.read(url, maximumBytes: 100), Data("A\nBB\n".utf8))
        try log.append(Data("D\n".utf8), flush: nil)
        log.close()
        XCTAssertEqual(try files.read(url, maximumBytes: 100), Data("A\nBB\nD\n".utf8))
    }

    func testACutAtOrPastTheEndWritesNothing() throws {
        for (form, files) in forms() {
            let url = file("current.jsonl", form)
            let log = try files.log(url)
            try log.append(Data("A\n".utf8), flush: nil)
            let before = try raw(url)
            var flushed = 0
            DeviceFiles.flushObserver = { _, _ in flushed += 1 }
            try log.cut(keepingPlainBytes: 2)
            try log.cut(keepingPlainBytes: 10)
            DeviceFiles.flushObserver = nil
            XCTAssertEqual(flushed, 0, form)
            XCTAssertEqual(try raw(url), before, form)
        }
    }

    func testAKeyedCutInsideAnAuthenticatedRecordIsRefusedAndLeavesTheLog() throws {
        let url = file("current.jsonl")
        let log = try keyed.log(url)
        try log.append(Data("A\n".utf8), flush: nil)
        try log.append(Data("BB\nCC".utf8), flush: nil)
        let before = try raw(url)
        XCTAssertThrowsError(try log.cut(keepingPlainBytes: 5)) {
            guard case .unreadable = $0 as? DeviceFileError else { return XCTFail("\($0)") }
        }
        XCTAssertEqual(try raw(url), before)
        XCTAssertEqual(try keyed.read(url, maximumBytes: 100), Data("A\nBB\nCC".utf8))
    }

    func testAFailedPlainCutClosesTheLogAndItsNextCallOpensItAgain() throws {
        let files = DeviceFiles(.plain)
        let url = file("current.jsonl")
        let log = try files.log(url)
        for line in ["A\n", "B\n"] { try log.append(Data(line.utf8), flush: nil) }
        DeviceFiles.failStep = { seen, step in seen == url && step == .cut ? EIO : nil }
        XCTAssertThrowsError(try log.cut(keepingPlainBytes: 2))
        DeviceFiles.failStep = nil
        try log.append(Data("C\n".utf8), flush: nil)
        XCTAssertEqual(try files.read(url, maximumBytes: 100), Data("A\nB\nC\n".utf8))
    }

    func testALogReplacedWholeIsWrittenBesideFlushedRenamedAndItsFolderFlushedInBothForms() throws {
        for (form, files) in forms() {
            let folder = directory.appendingPathComponent(form, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appendingPathComponent("cache.jsonl")
            let log = try files.log(url)
            try log.append(Data("old\n".utf8), flush: nil)
            log.close()
            var flushed: [String] = []
            DeviceFiles.flushObserver = { seen, flush in flushed.append("\(seen == url ? "file" : seen.path == folder.path ? "folder" : "beside") \(flush)") }
            try files.replaceLog(url, with: Data("A\nBB\n".utf8))
            DeviceFiles.flushObserver = nil
            XCTAssertEqual(flushed, ["beside barrier", "folder full"], form)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), ["cache.jsonl"], form)
            XCTAssertEqual(try files.read(url, maximumBytes: 100), Data("A\nBB\n".utf8), form)
            let appending = try files.log(url)
            XCTAssertFalse(appending.damaged, form)
            try appending.append(Data("C\n".utf8), flush: nil)
            appending.close()
            XCTAssertEqual(try files.read(url, maximumBytes: 100), Data("A\nBB\nC\n".utf8), form)
        }
        XCTAssertEqual(try raw(directory.appendingPathComponent("plain/cache.jsonl")),
                       Data("A\nBB\nC\n".utf8), "a plain log replaced whole is its bytes")
        let keyedDisk = try raw(directory.appendingPathComponent("keyed/cache.jsonl"))
        XCTAssertEqual(keyedDisk.first, LogLayout.mark)
        XCTAssertEqual(records(keyedDisk).count, 2, "one record replaced whole, one appended")
    }

    func testALogReplacedWholeOverARecordsBoundIsWrittenAsBoundedRecordsInBothForms() throws {
        let line = Data((String(repeating: "x", count: 99) + "\n").utf8)
        let lines = 2 * LogLayout.maximumRecord / line.count + 1
        let data = Data((0..<lines).map { _ in line }.joined())
        for (form, files) in forms() {
            let url = file("cache.jsonl", form)
            let log = try files.log(url)
            try log.append(Data("old\n".utf8), flush: nil)
            log.close()
            try files.replaceLog(url, with: data)
            XCTAssertEqual(try files.read(url, maximumBytes: data.count + 2), data, form)
            let appending = try files.log(url)
            XCTAssertFalse(appending.damaged, form)
            try appending.append(Data("C\n".utf8), flush: nil)
            appending.close()
            XCTAssertEqual(try files.read(url, maximumBytes: data.count + 2), data + Data("C\n".utf8), form)
        }
        XCTAssertEqual(try raw(file("cache.jsonl", "plain")), data + Data("C\n".utf8), "a plain log replaced whole is its bytes")
        let parts = records(try raw(file("cache.jsonl", "keyed")))
        XCTAssertEqual(parts.count, 4, "three bounded records replaced whole, one appended")
        XCTAssertTrue(parts.allSatisfy { $0.count <= LogLayout.overhead + LogLayout.maximumRecord })
    }

    func testAFailedRenameOfALogReplacedWholeLeavesNothingBeside() throws {
        for (form, files) in forms() {
            let folder = directory.appendingPathComponent(form, isDirectory: true)
            let url = folder.appendingPathComponent("cache.jsonl")
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            try Data("x".utf8).write(to: url.appendingPathComponent("held"))
            XCTAssertThrowsError(try files.replaceLog(url, with: Data("A\n".utf8)), form)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), ["cache.jsonl"], form)
        }
    }
}
