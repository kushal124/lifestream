import Darwin
import Foundation
import XCTest
@testable import DeviceFiles

final class DurableTests: FilesTestCase {
    private func recordBytes(_ form: String, _ text: String) -> off_t {
        off_t(form == "keyed" ? LogLayout.overhead + text.utf8.count : text.utf8.count)
    }

    private func start(_ form: String) -> off_t {
        off_t(form == "keyed" ? LogLayout.headerBytes : 0)
    }

    func testAnExclusiveWriteSurvivesReopenAndRestrictsPermissions() throws {
        let bytes = Data((0..<100_000).map { UInt8(truncatingIfNeeded: $0) })
        for (form, files) in forms() {
            let path = file("artifact", form)
            try files.writeNew(path, bytes, flush: .full)
            try DeviceFiles.syncDirectory(directory)
            XCTAssertEqual(try files.read(path, maximumBytes: bytes.count), bytes, form)
            let before = try raw(path)
            XCTAssertThrowsError(try files.writeNew(path, Data([99]), flush: .full), form)
            XCTAssertEqual(try raw(path), before, form)
            let attributes = try FileManager.default.attributesOfItem(atPath: path.path)
            XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600, form)
        }
    }

    func testALogKeepsEveryRecordAcrossOwnersAndEmptiesOnTruncate() throws {
        for (form, files) in forms() {
            let path = file("events", form)
            var log: Log? = try files.log(path)
            try log?.append(Data("first\n".utf8), flush: .full)
            log = try files.log(path)
            try log?.append(Data("second\n".utf8), flush: nil)
            try log?.flush(.full)
            XCTAssertEqual(try files.read(path, maximumBytes: 100), Data("first\nsecond\n".utf8), form)
            try log?.truncate()
            try log?.append(Data("third\n".utf8), flush: .barrier)
            XCTAssertEqual(try files.read(path, maximumBytes: 100), Data("third\n".utf8), form)
        }
    }

    func testReadAndSyncRejectSymlinksAndNonregularPaths() throws {
        let target = file("target")
        try Data([1, 2, 3]).write(to: target)
        let link = file("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        for (form, files) in forms() {
            XCTAssertThrowsError(try files.read(link, maximumBytes: 10), form)
            XCTAssertThrowsError(try files.writeNew(link, Data([9]), flush: .full), form)
            XCTAssertThrowsError(try files.log(link), form)
            XCTAssertThrowsError(try files.read(directory, maximumBytes: 10), form)
        }
        XCTAssertThrowsError(try DeviceFiles.syncFile(link))
        XCTAssertThrowsError(try DeviceFiles.syncDirectory(link))
        XCTAssertEqual(try raw(target), Data([1, 2, 3]))
    }

    func testBoundsAndFailuresRetainActionableCauses() throws {
        for (form, files) in forms() {
            let path = file("oversized", form)
            try files.writeNew(path, Data([1, 2, 3]), flush: .data)
            XCTAssertThrowsError(try files.read(path, maximumBytes: 2), form) {
                XCTAssertEqual($0 as? DeviceFileError, .invalidSizeOrType(name: "\(form)-oversized", maximumBytes: 2))
            }
            XCTAssertThrowsError(try files.log(directory.appendingPathComponent("absent/events")), form) {
                XCTAssertEqual($0 as? DeviceFileError, .io(operation: "open events", code: ENOENT))
            }
            let empty = file("empty", form)
            try files.writeNew(empty, Data(), flush: .data)
            XCTAssertThrowsError(try files.read(empty, maximumBytes: 2), form) {
                XCTAssertEqual($0 as? DeviceFileError, .invalidSizeOrType(name: "\(form)-empty", maximumBytes: 2))
            }
        }
    }

    func testAHalfWrittenRecordIsCutBackBehindABarrier() throws {
        for (form, files) in forms() {
            let path = file("events", form)
            let log = try files.log(path)
            try log.append(Data("A\n".utf8), flush: nil)
            var flushes: [DeviceFiles.Flush] = []
            DeviceFiles.flushObserver = { url, flush in if url == path { flushes.append(flush) } }
            DeviceFiles.writeLimit = 3
            XCTAssertThrowsError(try log.append(Data("BBBBBB\n".utf8), flush: nil), form) {
                XCTAssertEqual($0 as? DeviceFileError, .io(operation: "write", code: ENOSPC))
            }
            XCTAssertEqual(flushes, [.barrier], "the cut is ordered before whatever is appended next")
            XCTAssertFalse(log.damaged, form)
            XCTAssertEqual(log.end, start(form) + recordBytes(form, "A\n"), form)
            DeviceFiles.writeLimit = nil
            DeviceFiles.flushObserver = nil
            try log.append(Data("C\n".utf8), flush: nil)
            XCTAssertEqual(try files.read(path, maximumBytes: 100), Data("A\nC\n".utf8), form)
            XCTAssertEqual(log.end, start(form) + 2 * recordBytes(form, "A\n"), form)
            XCTAssertEqual(try raw(path).count, Int(log.end), form)
        }
    }

    func testAWriteThatLandedNothingIssuesNoCut() throws {
        for (form, files) in forms() {
            let path = file("events", form)
            let log = try files.log(path)
            try log.append(Data("A\n".utf8), flush: nil)
            let before = try raw(path)
            var flushes: [DeviceFiles.Flush] = []
            DeviceFiles.flushObserver = { _, flush in flushes.append(flush) }
            DeviceFiles.writeLimit = 0
            XCTAssertThrowsError(try log.append(Data("B\n".utf8), flush: .full), form)
            XCTAssertEqual(flushes, [], form)
            XCTAssertEqual(try raw(path), before, form)
            DeviceFiles.writeLimit = nil
            DeviceFiles.flushObserver = nil
        }
    }

    func testAFailingCutMakesEveryAppendThrowUntilItHolds() throws {
        for (form, files) in forms() {
            let path = file("events", form)
            let log = try files.log(path)
            try log.append(Data("A\n".utf8), flush: nil)
            var cutFails = true
            DeviceFiles.failStep = { _, step in step == .cut && cutFails ? EIO : nil }
            DeviceFiles.writeLimit = 1
            XCTAssertThrowsError(try log.append(Data("BB\n".utf8), flush: nil), form)
            XCTAssertTrue(log.damaged, form)
            DeviceFiles.writeLimit = nil
            XCTAssertThrowsError(try log.append(Data("C\n".utf8), flush: nil), form) {
                XCTAssertEqual($0 as? DeviceFileError, .io(operation: "cut \(form)-events", code: EIO))
            }
            XCTAssertThrowsError(try log.repair(), form)
            XCTAssertEqual(try raw(path).count, Int(start(form) + recordBytes(form, "A\n")) + 1, "nothing lands after a torn record")
            XCTAssertEqual(try files.read(path, maximumBytes: 100), Data(form == "keyed" ? "A\n".utf8 : "A\nB".utf8), form)
            cutFails = false
            try log.append(Data("C\n".utf8), flush: nil)
            XCTAssertFalse(log.damaged, form)
            XCTAssertEqual(try files.read(path, maximumBytes: 100), Data("A\nC\n".utf8), form)
            DeviceFiles.failStep = nil
        }
    }

    func testACutWhoseBarrierFailsIsDamagedAndRepairCutsItAgain() throws {
        for (form, files) in forms() {
            let path = file("events", form)
            let log = try files.log(path)
            try log.append(Data("A\n".utf8), flush: nil)
            var barrierFails = true
            DeviceFiles.failStep = { _, step in step == .flush(.barrier) && barrierFails ? EIO : nil }
            DeviceFiles.writeLimit = 1
            XCTAssertThrowsError(try log.append(Data("BB\n".utf8), flush: nil), form)
            DeviceFiles.writeLimit = nil
            XCTAssertTrue(log.damaged, form)
            XCTAssertThrowsError(try log.repair(), form)
            barrierFails = false
            try log.repair()
            XCTAssertFalse(log.damaged, form)
            try log.repair()
            XCTAssertEqual(try files.read(path, maximumBytes: 100), Data("A\n".utf8), form)
            DeviceFiles.failStep = nil
        }
    }

    func testAFlushThatFailsAfterAWholeWriteKeepsTheRecordAndSaysNotFlushed() throws {
        for (form, files) in forms() {
            let path = file("events", form)
            let log = try files.log(path)
            DeviceFiles.failStep = { _, step in step == .flush(.full) ? EIO : nil }
            XCTAssertThrowsError(try log.append(Data("A\n".utf8), flush: .full), form) {
                XCTAssertEqual($0 as? DeviceFileError, .notFlushed(name: "\(form)-events", code: EIO))
            }
            XCTAssertEqual(log.end, start(form) + recordBytes(form, "A\n"), form)
            XCTAssertFalse(log.damaged, form)
            DeviceFiles.failStep = nil
            DeviceFiles.writeLimit = 1
            XCTAssertThrowsError(try log.append(Data("BB\n".utf8), flush: nil), form)
            DeviceFiles.writeLimit = nil
            XCTAssertEqual(try files.read(path, maximumBytes: 100), Data("A\n".utf8), "the unflushed record is whole and stays")
        }
    }

    func testAfterTruncateAFailedAppendLeavesTheFileEmpty() throws {
        for (form, files) in forms() {
            let path = file("events", form)
            let log = try files.log(path)
            try log.append(Data("first line\n".utf8), flush: nil)
            try log.truncate()
            XCTAssertEqual(log.end, start(form), form)
            DeviceFiles.writeLimit = 3
            XCTAssertThrowsError(try log.append(Data("second line\n".utf8), flush: nil), form)
            DeviceFiles.writeLimit = nil
            XCTAssertEqual(try files.size(of: path), 0, form)
            XCTAssertEqual(try raw(path).count, Int(start(form)), form)
        }
    }

    func testTheEndAtOpenIsTheFileSoACutKeepsAnEarlierOwnersRecords() throws {
        for (form, files) in forms() {
            let path = file("events", form)
            let first = try files.log(path)
            try first.append(Data("A\n".utf8), flush: nil)
            try first.append(Data("B\n".utf8), flush: nil)
            let log = try files.log(path)
            XCTAssertEqual(log.end, start(form) + 2 * recordBytes(form, "A\n"), form)
            DeviceFiles.writeLimit = 1
            XCTAssertThrowsError(try log.append(Data("CC\n".utf8), flush: nil), form)
            DeviceFiles.writeLimit = nil
            XCTAssertEqual(try files.read(path, maximumBytes: 100), Data("A\nB\n".utf8), form)
        }
    }

    func testMoveFreshNeverOverwrites() throws {
        let made = file("made")
        try Data("one".utf8).write(to: made)
        try Data("kept".utf8).write(to: file("segment.mov"))
        let moved = try DeviceFiles.moveFresh(made, into: directory, stem: "segment", suffix: ".mov")
        XCTAssertEqual(moved.lastPathComponent, "segment-2.mov")
        XCTAssertEqual(try raw(file("segment.mov")), Data("kept".utf8))
    }
}
