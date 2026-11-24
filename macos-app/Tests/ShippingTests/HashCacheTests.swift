import Darwin
import DeviceFiles
import Foundation
import XCTest
@testable import Shipping

final class HashCacheTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("hash-cache-tests")
    }

    override func tearDownWithError() throws {
        DeviceFiles.flushObserver = nil
        try? FileManager.default.removeItem(at: root)
    }

    private var cacheFile: URL { root.appendingPathComponent("cache/imessage_a@example.com_unit-0001.json") }

    private func media(_ name: String, _ text: String) throws -> URL {
        try DomainFixtures.write(text, to: root.appendingPathComponent("media/\(name)"))
    }

    private func modified(_ url: URL) throws -> timespec {
        guard let status = FileFacts.of(url.path) else { throw DomainFixtures.FixtureError.file("stat \(url.lastPathComponent)") }
        return status.st_mtimespec
    }

    private func setModified(_ url: URL, to time: timespec) throws {
        var times = [time, time]
        guard utimensat(AT_FDCWD, url.path, &times, 0) == 0 else {
            throw DomainFixtures.FixtureError.file("set the time of \(url.lastPathComponent)")
        }
    }

    func testASecondMeasureHitsWhenSizeAndTimeBothMatch() throws {
        let file = try media("photo.jpg", "alpha")
        var first = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        XCTAssertEqual(try first.measure(locator: "Media/photo.jpg", file: file)?.sha256, DomainFixtures.sha256("alpha"))
        try first.save()

        let when = try modified(file)
        try DomainFixtures.write("bravo", to: file)
        try setModified(file, to: when)

        var second = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        let measured = try XCTUnwrap(try second.measure(locator: "Media/photo.jpg", file: file))
        XCTAssertEqual(measured.sha256, DomainFixtures.sha256("alpha"), "the cached hash is answered, the file is not re-read")
        XCTAssertEqual(measured.bytes, 5)
    }

    func testASecondMeasureMissesWhenTheSizeChanged() throws {
        let file = try media("photo.jpg", "alpha")
        var first = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        _ = try first.measure(locator: "Media/photo.jpg", file: file)
        try first.save()

        let when = try modified(file)
        try DomainFixtures.write("alpha!", to: file)
        try setModified(file, to: when)

        var second = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        XCTAssertEqual(try second.measure(locator: "Media/photo.jpg", file: file)?.sha256, DomainFixtures.sha256("alpha!"))
    }

    func testASecondMeasureMissesWhenTheModificationTimeChanged() throws {
        let file = try media("photo.jpg", "alpha")
        var first = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        _ = try first.measure(locator: "Media/photo.jpg", file: file)
        try first.save()

        try DomainFixtures.write("bravo", to: file)
        try setModified(file, to: timespec(tv_sec: 1_700_000_000, tv_nsec: 123_456_789))

        var second = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        XCTAssertEqual(try second.measure(locator: "Media/photo.jpg", file: file)?.sha256, DomainFixtures.sha256("bravo"))
    }

    func testACacheThatCannotBeReadIsDiscardedNotRefused() throws {
        try DomainFixtures.write("{ not the cache format", to: cacheFile)
        let file = try media("photo.jpg", "alpha")
        var cache = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        XCTAssertEqual(cache.count, 0)
        XCTAssertEqual(try cache.measure(locator: "Media/photo.jpg", file: file)?.sha256, DomainFixtures.sha256("alpha"))
        try cache.save()
        XCTAssertEqual(HashCache(file: cacheFile, files: DeviceFiles(.plain)).count, 1)
    }

    private func line(_ locator: String, _ url: URL, _ text: String) throws -> String {
        let time = try modified(url)
        let nanoseconds = Int(time.tv_sec) * 1_000_000_000 + Int(time.tv_nsec)
        return "{\"locator\":\"\(locator)\",\"bytes\":\(text.utf8.count),\"mtime_ns\":\(nanoseconds),"
            + "\"sha256\":\"\(DomainFixtures.sha256(text))\"}\n"
    }

    private let header = "{\"format\":\"org.lifestreamprotocol.hash-cache/2\"}\n"

    private func text() throws -> String { try String(contentsOf: cacheFile, encoding: .utf8) }

    func testANewCacheIsTheFormatLineThenOneLinePerEntrySorted() throws {
        let second = try media("b.txt", "bravo")
        let first = try media("a.txt", "alpha")
        var cache = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        _ = try cache.measure(locator: "b.txt", file: second)
        _ = try cache.measure(locator: "a.txt", file: first)
        try cache.save()
        XCTAssertEqual(try text(), header + (try line("a.txt", first, "alpha")) + (try line("b.txt", second, "bravo")))
    }

    func testALaterSaveAppendsOnlyWhatItMeasured() throws {
        let first = try media("a.txt", "alpha")
        var cache = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        _ = try cache.measure(locator: "a.txt", file: first)
        try cache.save()
        let before = try text()

        let second = try media("b.txt", "bravo")
        var again = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        _ = try again.measure(locator: "a.txt", file: first)
        _ = try again.measure(locator: "b.txt", file: second)
        try again.save()
        XCTAssertEqual(try text(), before + (try line("b.txt", second, "bravo")))
    }

    func testASaveWithNothingMeasuredWritesNothing() throws {
        let first = try media("a.txt", "alpha")
        var cache = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        _ = try cache.measure(locator: "a.txt", file: first)
        try cache.save()
        try setModified(cacheFile, to: timespec(tv_sec: 1_700_000_000, tv_nsec: 0))

        var again = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        _ = try again.measure(locator: "a.txt", file: first)
        try again.save()
        XCTAssertEqual(try modified(cacheFile).tv_sec, 1_700_000_000)
    }

    func testALaterLineForALocatorReplacesTheEarlierOne() throws {
        let file = try media("photo.jpg", "alpha")
        var cache = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        _ = try cache.measure(locator: "photo.jpg", file: file)
        try cache.save()

        try DomainFixtures.write("bravo!", to: file)
        var again = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        XCTAssertEqual(try again.measure(locator: "photo.jpg", file: file)?.sha256, DomainFixtures.sha256("bravo!"))
        try again.save()
        XCTAssertEqual(try text().split(separator: "\n").count, 3, "the format line and two lines for one locator")

        try DomainFixtures.write("bravo?", to: file)
        try setModified(file, to: try modified(file))
        var third = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        XCTAssertEqual(third.count, 1)
        let later = try modified(file)
        try DomainFixtures.write("bravo!", to: file)
        try setModified(file, to: later)
        XCTAssertEqual(try third.measure(locator: "photo.jpg", file: file)?.bytes, 6)
    }

    func testATornLastLineIsSkippedAndTheNextSaveWritesTheWholeFile() throws {
        let first = try media("a.txt", "alpha")
        let second = try media("b.txt", "bravo")
        let torn = String((try line("b.txt", second, "bravo")).dropLast(20))
        try DomainFixtures.write(header + (try line("a.txt", first, "alpha")) + torn, to: cacheFile)

        var cache = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        XCTAssertEqual(cache.count, 1, "the torn line is not an entry")
        _ = try cache.measure(locator: "b.txt", file: second)
        try cache.save()
        XCTAssertEqual(try text(), header + (try line("a.txt", first, "alpha")) + (try line("b.txt", second, "bravo")))
    }

    func testACacheInTheFormatBeforeIsReadAndWrittenAgainAsLines() throws {
        let first = try media("a.txt", "alpha")
        let second = try media("b.txt", "bravo")
        let time = try modified(first)
        let nanoseconds = Int(time.tv_sec) * 1_000_000_000 + Int(time.tv_nsec)
        try DomainFixtures.write("{\"format\":\"org.lifestreamprotocol.hash-cache/1\",\"entries\":{\"a.txt\":"
            + "{\"bytes\":5,\"mtime_ns\":\(nanoseconds),\"sha256\":\"\(DomainFixtures.sha256("alpha"))\"}}}\n", to: cacheFile)

        var cache = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        XCTAssertEqual(cache.count, 1)
        try DomainFixtures.write("omega", to: first)
        try setModified(first, to: time)
        XCTAssertEqual(try cache.measure(locator: "a.txt", file: first)?.sha256, DomainFixtures.sha256("alpha"),
                       "the old entry is a hit")
        _ = try cache.measure(locator: "b.txt", file: second)
        try cache.save()
        XCTAssertEqual(try text(), header + "{\"locator\":\"a.txt\",\"bytes\":5,\"mtime_ns\":\(nanoseconds),"
            + "\"sha256\":\"\(DomainFixtures.sha256("alpha"))\"}\n" + (try line("b.txt", second, "bravo")))
    }

    func testSupersededLinesAreCompactedAway() throws {
        let file = try media("photo.jpg", "a")
        for round in 0..<70 {
            try DomainFixtures.write(String(repeating: "a", count: round + 1), to: file)
            var cache = HashCache(file: cacheFile, files: DeviceFiles(.plain))
            _ = try cache.measure(locator: "photo.jpg", file: file)
            try cache.save()
        }
        let lines = try text().split(separator: "\n").count
        XCTAssertLessThanOrEqual(lines, 65, "one entry never keeps more than the floor of lines")
        XCTAssertEqual(HashCache(file: cacheFile, files: DeviceFiles(.plain)).count, 1)
        var last = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        XCTAssertEqual(try last.measure(locator: "photo.jpg", file: file)?.bytes, 70)
    }

    func testARewriteIsALogReplacedWholeAndCompactionKeepsTheLastLineInBothForms() throws {
        let file = try media("photo.jpg", "a")
        for files in [DeviceFiles(.plain), DeviceFiles(.keyed(ShippingFixture.macKey))] {
            var flushed: [String] = []
            let cacheFile = cacheFile
            DeviceFiles.flushObserver = { seen, flush in
                flushed.append("\(seen.path == cacheFile.deletingLastPathComponent().path ? "folder" : seen == cacheFile ? "file" : "beside") \(flush)")
            }
            var first = HashCache(file: cacheFile, files: files)
            _ = try first.measure(locator: "photo.jpg", file: file)
            try first.save()
            DeviceFiles.flushObserver = nil
            XCTAssertEqual(flushed, ["beside barrier", "folder full"], "keyed \(files.keyed): written beside, renamed over, its folder flushed")
            for round in 1..<70 {
                try DomainFixtures.write(String(repeating: "a", count: round + 1), to: file)
                var cache = HashCache(file: cacheFile, files: files)
                _ = try cache.measure(locator: "photo.jpg", file: file)
                try cache.save()
            }
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cacheFile.deletingLastPathComponent().path),
                           [cacheFile.lastPathComponent], "keyed \(files.keyed): nothing left beside")
            var last = HashCache(file: cacheFile, files: files)
            XCTAssertEqual(last.count, 1)
            XCTAssertEqual(try last.measure(locator: "photo.jpg", file: file)?.bytes, 70)
            try FileManager.default.removeItem(at: cacheFile)
        }
    }

    func testAStoresFileMeasuresAsNoneOrSaysWhyItDidNotOpen() throws {
        let road = StoreFiles(home: root, lifestream: []).opener
        var cache = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        XCTAssertNil(try cache.measure(locator: "gone.jpg", file: root.appendingPathComponent("media/gone.jpg"), opener: road))
        _ = try media("folder/inside.jpg", "alpha")
        XCTAssertNil(try cache.measure(locator: "folder", file: root.appendingPathComponent("media/folder"), opener: road))

        let file = try media("locked.jpg", "alpha")
        XCTAssertEqual(chmod(file.path, 0), 0)
        defer { chmod(file.path, 0o644) }
        XCTAssertThrowsError(try cache.measure(locator: "locked.jpg", file: file, opener: road)) {
            XCTAssertEqual($0 as? FileOpenerError, .unreadable(EACCES))
            XCTAssertEqual("\($0)", "a file cannot be opened: Permission denied")
        }
    }

    func testAFailingFileIsRememberedUntilItIsMeasured() throws {
        let start = try DomainFixtures.instant("2026-09-23T04:00:00.000Z")
        func at(_ minutes: Double) -> Date { start.addingTimeInterval(minutes * 60) }
        var cache = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        cache.failed(locator: "Media/a.jpg", why: "a file cannot be opened: Permission denied", at: at(0))
        try cache.save()
        XCTAssertTrue(cache.failing(at: at(0)).isEmpty, "one failure is no trouble")

        var later = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        later.failed(locator: "Media/a.jpg", why: "a file cannot be opened: Permission denied", at: at(59))
        XCTAssertTrue(later.failing(at: at(59)).isEmpty, "failing for under an hour")
        later.failed(locator: "Media/a.jpg", why: "a file cannot be opened: Permission denied", at: at(60))
        try later.save()

        let read = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        XCTAssertEqual(read.failing(at: at(60)).map(\.locator), ["Media/a.jpg"], "its first failure was kept across saves")
        XCTAssertEqual(read.failing(at: at(60)).first?.why, "a file cannot be opened: Permission denied")
        XCTAssertEqual(read.failing(at: at(120)).map(\.locator), ["Media/a.jpg"], "failed last within the hour")
        XCTAssertTrue(read.failing(at: at(121)).isEmpty, "a file no read asks for again is no one's trouble")

        let file = try media("a.jpg", "alpha")
        var measured = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        XCTAssertEqual(try measured.measure(locator: "Media/a.jpg", file: file)?.sha256, DomainFixtures.sha256("alpha"))
        try measured.save()
        XCTAssertEqual(HashCache(file: cacheFile, files: DeviceFiles(.plain)).failing(at: at(60)).map(\.locator), ["Media/a.jpg"],
                       "a file that hashes may still not carry: a hash alone ends nothing")

        var shipped = HashCache(file: cacheFile, files: DeviceFiles(.plain))
        XCTAssertEqual(try shipped.measure(locator: "Media/a.jpg", file: file)?.sha256, DomainFixtures.sha256("alpha"))
        shipped.shipped(["Media/a.jpg"])
        try shipped.save()
        XCTAssertTrue(HashCache(file: cacheFile, files: DeviceFiles(.plain)).failing(at: at(60)).isEmpty, "the bundle that ships it ends it")
        XCTAssertEqual(HashCache(file: cacheFile, files: DeviceFiles(.plain)).count, 1)
    }
}
