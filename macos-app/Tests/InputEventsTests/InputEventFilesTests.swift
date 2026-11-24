import Evidence
import DeviceFiles
import Foundation
import XCTest
@testable import InputEvents

final class InputEventFilesTests: XCTestCase {
    private var root: URL!
    private let zone = TimeZone(identifier: "Asia/Kolkata")!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("input-events-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        DeviceFiles.writeLimit = nil
        DeviceFiles.failStep = nil
        DeviceFiles.flushObserver = nil
        _ = chmod(folder.path, 0o700)
        try? FileManager.default.removeItem(at: root)
    }

    private var folder: URL { root.appendingPathComponent(InputEventBatch.directoryName) }
    private var openBatch: URL { folder.appendingPathComponent(InputEventBatch.openName) }
    private var openChunk: URL { folder.appendingPathComponent(InputEventBatch.chunkName) }

    private static let pinnedLine = #"{"at":"2026-09-23T10:03:00.000Z","until":"2026-09-23T10:04:00.000Z","layout":"com.apple.keylayout.US","apps":["com.example.editor","com.example.browser"],"events":[{"t":412,"e":"activate","app":1,"pid":501},{"t":980,"e":"down","button":"left","x":640.5,"y":88,"clicks":1,"app":1,"el":{"action":{"role":"AXLink","title":"Downloads","url":"https://example.com/downloads"},"ms":3,"role":"AXStaticText","value":"Downloads"}},{"t":1071,"e":"up","button":"left","x":640.5,"y":88,"clicks":1,"app":1},{"t":2210,"e":"key_down","code":0,"key":"a","app":1,"el":{"ms":2,"role":"AXTextField","title":"Search"}},{"t":2288,"e":"key_up","code":0,"app":1}]}"#

    private static let pinnedChunk = InputChunk(
        at: Synthetic.date("2026-09-23T10:03:00.000Z"), until: Synthetic.date("2026-09-23T10:04:00.000Z"),
        layout: "com.apple.keylayout.US", apps: [Synthetic.editor, Synthetic.browser],
        events: [
            InputEvent(t: 412, body: .activate(app: 1, pid: 501)),
            InputEvent(t: 980, body: .down(InputPointer(
                button: InputButton(number: 0), x: 640.5, y: 88, clicks: 1, app: 1,
                el: InputElement(attributes: InputElementAttributes(role: "AXStaticText", value: "Downloads"),
                                 action: InputElementAttributes(role: "AXLink", title: "Downloads",
                                                                url: "https://example.com/downloads"),
                                 ms: 3)))),
            InputEvent(t: 1071, body: .up(InputPointer(button: InputButton(number: 0), x: 640.5, y: 88,
                                                       clicks: 1, app: 1))),
            InputEvent(t: 2210, body: .keyDown(InputKeyDown(
                code: 0, key: "a", app: 1,
                el: InputElement(attributes: InputElementAttributes(role: "AXTextField", title: "Search"), ms: 2)))),
            InputEvent(t: 2288, body: .keyUp(code: 0, app: 1, syn: nil)),
        ])

    private func openFiles() throws -> InputEventFiles {
        try InputEventFiles(recorderDirectory: root, files: DeviceFiles(.plain), timeZone: zone)
    }

    private func lines(_ url: URL) throws -> [String] {
        try String(contentsOf: url, encoding: .utf8).split(separator: "\n").map(String.init)
    }

    private func size(_ url: URL) -> Int {
        ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int) ?? -1
    }

    private func chunk(at spelling: String, events: Int = 1, seconds: Double = 60) -> InputChunk {
        let at = Synthetic.date(spelling)
        return InputChunk(at: at, until: at.addingTimeInterval(seconds), layout: "com.apple.keylayout.US",
                          apps: [Synthetic.editor],
                          events: (0..<events).map { InputEvent(t: $0 * 10, body: .keyUp(code: $0, app: 0, syn: nil)) })
    }

    private func write(_ build: (ChunkerOnFiles) -> Void) throws -> InputEventFiles {
        let files = try openFiles()
        let driver = ChunkerOnFiles(files: files, zone: zone)
        build(driver)
        return files
    }


    func testEventsReachTheOpenMinuteBeforeTheChunkLineAndTheMinuteIsClearedAfterIt() throws {
        let files = try write { driver in
            driver.chunker.handle(Synthetic.raw(.leftMouseUp, at: Synthetic.opened.addingTimeInterval(5)), uptime: 0)
        }
        let open = try lines(openChunk)
        XCTAssertEqual(open.count, 4, "header, log_start, the app, the event")
        XCTAssertEqual(open[0], #"{"chunk":"2026-09-23T10:02:30.000Z","layout":"com.apple.keylayout.US"}"#)
        XCTAssertEqual(open[1], #"{"t":0,"e":"log_start","input_monitoring":true,"accessibility":true}"#)
        XCTAssertEqual(open[2], #"{"app":0,"name":"com.example.editor"}"#)
        XCTAssertEqual(open[3], #"{"t":5000,"e":"up","button":"left","x":0,"y":0,"clicks":1,"app":0}"#)
        XCTAssertFalse(FileManager.default.fileExists(atPath: openBatch.path), "no line before the close")

        files.chunkClosed(InputEventFiles.rebuild(try Data(contentsOf: openChunk)).map {
            var closed = $0
            closed.recovered = false
            closed.until = Synthetic.minute
            return closed
        })
        let published = try lines(openBatch)
        XCTAssertEqual(published.count, 1)
        XCTAssertEqual(try InputEventCodec.chunk(published[0]).events.count, 2)
        XCTAssertEqual(size(openChunk), 0, "the open minute is cleared only after the line is durable")
    }


    private func countedChunk(at spelling: String) -> InputChunk {
        var counted = chunk(at: spelling, events: 3)
        counted.lost = 2
        counted.activity = [InputActivity(app: 0, keys: 4, clicks: 1, scrolls: 2, moves: 5)]
        return counted
    }

    private static let lossOnlyLine =
        #"{"at":"2026-09-23T10:03:00.000Z","until":"2026-09-23T10:04:00.000Z","layout":"com.apple.keylayout.US","apps":[],"events":[],"lost":17}"#

    func testAMinuteRefusedForSpaceIsItsLossOnlyLineInItsOwnDay() throws {
        let space = Space(true)
        let files = try InputEventFiles(recorderDirectory: root, files: DeviceFiles(.plain), timeZone: zone, fits: { space.fits })
        files.chunkClosed(chunk(at: "2026-09-22T20:00:00.000Z"))
        space.fits = false
        files.chunkClosed(countedChunk(at: "2026-09-23T10:03:00.000Z"))
        XCTAssertEqual(files.sealedBatches(), ["20260922T200000.000Z.jsonl"], "the day before sealed first")
        XCTAssertEqual(try lines(openBatch), [Self.lossOnlyLine])
        XCTAssertEqual(try InputEventCodec.chunk(Self.lossOnlyLine).lost, 17)
        space.fits = true
        files.chunkClosed(chunk(at: "2026-09-23T10:04:00.000Z"))
        XCTAssertEqual(try lines(openBatch).count, 2, "the next minute lands whole")
    }

    func testAFullLineThatFailsIsFollowedByItsLossOnlyLine() throws {
        let files = try openFiles()
        DeviceFiles.writeLimit = 20
        DeviceFiles.flushObserver = { url, flush in
            if url.lastPathComponent == InputEventBatch.openName, flush == .barrier { DeviceFiles.writeLimit = nil }
        }
        files.chunkClosed(countedChunk(at: "2026-09-23T10:03:00.000Z"))
        XCTAssertEqual(try lines(openBatch), [Self.lossOnlyLine])
    }

    func testAMinuteLostUnstatedIsNotedOnceAStreak() throws {
        let failures = FailureLines()
        failures.configure(spool: root, plain: DeviceFiles(.plain), build: "b", pid: 1)
        let drops = MinuteDrops(lines: failures)
        let first = try InputEventFiles(recorderDirectory: root, files: DeviceFiles(.plain), timeZone: zone, drops: drops)
        try FileManager.default.createDirectory(at: openBatch, withIntermediateDirectories: true)
        first.chunkClosed(chunk(at: "2026-09-23T10:03:00.000Z"))
        first.chunkClosed(chunk(at: "2026-09-23T10:04:00.000Z"))
        first.close()
        try FileManager.default.removeItem(at: openBatch)
        let second = try InputEventFiles(recorderDirectory: root, files: DeviceFiles(.plain), timeZone: zone, drops: drops)
        second.chunkClosed(chunk(at: "2026-09-23T10:05:00.000Z"))
        second.chunkClosed(chunk(at: "2026-09-23T10:06:00.000Z"))
        XCTAssertEqual(try lines(openBatch).count, 2)
        failures.drain()
        let noted = try failureLines()
        XCTAssertEqual(noted.map { $0["event"] as? String }, ["minute_dropped", "minutes_written"])
        XCTAssertEqual(noted.map { $0["part"] as? String }, ["input_log", "input_log"])
        XCTAssertEqual(noted.map { $0["errno"] as? Int }, [Int(EISDIR), Int(EISDIR)])
        XCTAssertEqual(noted[1]["since"] as? String, noted[0]["at"] as? String, "the closing line carries the streak's start")
    }

    func testALineThatLandsBeforeAFailedSealIsPublished() throws {
        let files = try openFiles()
        files.chunkClosed(chunk(at: "2026-09-22T22:28:00.000Z"))
        XCTAssertEqual(chmod(folder.path, 0o500), 0, "a folder whose names cannot change: the seal's rename fails")
        files.chunkClosed(chunk(at: "2026-09-22T22:29:00.000Z"))
        XCTAssertEqual(chmod(folder.path, 0o700), 0)
        XCTAssertEqual(files.sealedBatches(), [])
        XCTAssertEqual(try lines(openBatch).map { try InputEventCodec.chunk($0).lost }, [0, 0], "no loss-only line")
        files.chunkClosed(chunk(at: "2026-09-22T22:30:00.000Z"))
        XCTAssertEqual(files.sealedBatches(), ["20260922T222800.000Z.jsonl"])
        XCTAssertEqual(try lines(folder.appendingPathComponent("20260922T222800.000Z.jsonl")).count, 2)
        XCTAssertEqual(try lines(openBatch).count, 1)
    }

    func testALineWrittenButNotFlushedIsPublishedAndSeals() throws {
        let files = try openFiles()
        var flushFails = true
        DeviceFiles.failStep = { url, step in
            url.lastPathComponent == InputEventBatch.openName && step == .flush(.full) && flushFails ? EIO : nil
        }
        files.chunkClosed(chunk(at: "2026-09-23T10:03:00.000Z"))
        flushFails = false
        XCTAssertEqual(try lines(openBatch).map { try InputEventCodec.chunk($0).events.count }, [1])
        XCTAssertEqual(files.lastUntil, Synthetic.date("2026-09-23T10:04:00.000Z"))
        try files.seal()
        files.close()
        XCTAssertEqual(files.sealedBatches(), ["20260923T100300.000Z.jsonl"])
    }

    func testALineThatFailsHalfWayIsCutBackAndTheNextFollowsWhole() throws {
        let files = try openFiles()
        try files.publish(chunk(at: "2026-09-23T10:03:00.000Z"))
        DeviceFiles.writeLimit = 20
        XCTAssertThrowsError(try files.publish(chunk(at: "2026-09-23T10:04:00.000Z")))
        DeviceFiles.writeLimit = nil
        try files.publish(chunk(at: "2026-09-23T10:05:00.000Z"))
        XCTAssertEqual(try lines(openBatch).map { try InputEventCodec.chunk($0).at },
                       [Synthetic.date("2026-09-23T10:03:00.000Z"), Synthetic.date("2026-09-23T10:05:00.000Z")])
    }

    func testABatchWhoseCutFailedIsNeverSealedUntilTheCutHolds() throws {
        let files = try openFiles()
        try files.publish(chunk(at: "2026-09-23T10:03:00.000Z"))
        let before = try Data(contentsOf: openBatch)
        var cutFails = true
        DeviceFiles.failStep = { url, step in
            url.lastPathComponent == InputEventBatch.openName && step == .cut && cutFails ? EIO : nil
        }
        DeviceFiles.writeLimit = 20
        XCTAssertThrowsError(try files.publish(chunk(at: "2026-09-23T10:04:00.000Z")))
        DeviceFiles.writeLimit = nil
        XCTAssertThrowsError(try files.seal(), "a batch whose cut failed is not sealed")
        XCTAssertEqual(files.sealedBatches(), [])
        cutFails = false
        try files.seal()
        XCTAssertEqual(try Data(contentsOf: folder.appendingPathComponent("20260923T100300.000Z.jsonl")), before)
    }

    func testAMinuteFileThatCannotBeClearedTakesNoSecondMinute() throws {
        let files = try openFiles()
        var clearFails = true
        DeviceFiles.failStep = { url, step in
            url.lastPathComponent == InputEventBatch.chunkName && step == .truncate && clearFails ? EIO : nil
        }
        let first = chunk(at: "2026-09-23T10:03:00.000Z")
        let second = chunk(at: "2026-09-23T10:04:00.000Z")
        let third = chunk(at: "2026-09-23T10:05:00.000Z")
        files.chunkOpened(at: first.at, layout: first.layout)
        files.appAdded(0, name: Synthetic.editor)
        files.eventFinished(first.events[0])
        files.chunkClosed(first)
        let held = try Data(contentsOf: openChunk)
        files.chunkOpened(at: second.at, layout: second.layout)
        files.appAdded(0, name: Synthetic.editor)
        files.eventFinished(second.events[0])
        XCTAssertEqual(try Data(contentsOf: openChunk), held, "the next minute's header and lines stay out")
        files.chunkClosed(second)
        XCTAssertEqual(try lines(openBatch).map { try InputEventCodec.chunk($0).at }, [first.at, second.at],
                       "each minute published from the chunker's copy")
        clearFails = false
        files.chunkOpened(at: third.at, layout: third.layout)
        XCTAssertEqual(try lines(openChunk), [#"{"chunk":"2026-09-23T10:05:00.000Z","layout":"com.apple.keylayout.US"}"#])
    }

    func testARestartAfterAnUnclearedMinuteRebuildsOneMinuteAndPublishesNothingTwice() throws {
        let files = try openFiles()
        DeviceFiles.failStep = { url, step in
            url.lastPathComponent == InputEventBatch.chunkName && step == .truncate ? EIO : nil
        }
        let first = chunk(at: "2026-09-23T10:03:00.000Z")
        let second = chunk(at: "2026-09-23T10:04:00.000Z")
        files.chunkOpened(at: first.at, layout: first.layout)
        files.appAdded(0, name: Synthetic.editor)
        files.eventFinished(first.events[0])
        files.chunkClosed(first)
        files.chunkOpened(at: second.at, layout: second.layout)
        files.eventFinished(second.events[0])
        files.chunkClosed(second)
        let rebuilt = try XCTUnwrap(InputEventFiles.rebuild(try Data(contentsOf: openChunk)))
        XCTAssertEqual(rebuilt.at, first.at)
        XCTAssertEqual(rebuilt.events, first.events, "one minute, not two glued")
        DeviceFiles.failStep = nil
        let restarted = try openFiles()
        XCTAssertEqual(restarted.sealedBatches(), ["20260923T100300.000Z.jsonl"])
        XCTAssertEqual(try lines(folder.appendingPathComponent("20260923T100300.000Z.jsonl")).map {
            try InputEventCodec.chunk($0).at
        }, [first.at, second.at])
    }

    private func failureLines() throws -> [[String: Any]] {
        let resources = root.appendingPathComponent("resources")
        return try FileManager.default.contentsOfDirectory(atPath: resources.path).sorted().flatMap { name in
            try String(contentsOf: resources.appendingPathComponent(name), encoding: .utf8).split(separator: "\n").map {
                try XCTUnwrap(try JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])
            }
        }
    }

    func testTheOpenMinuteRebuildsExactlyTheLineTheCloseWrites() throws {
        let driver = ChunkerOnFiles(files: try openFiles(), zone: zone)
        let base = Synthetic.opened.addingTimeInterval(1)
        driver.chunker.handle(Synthetic.raw(.leftMouseDown, at: base, target: 502, x: 3.25, y: 4), uptime: 1)
        driver.chunker.resolve(0, .found(InputElementAttributes(role: "AXButton", title: "Go"), action: nil), ms: 3)
        driver.chunker.handle(.secureInput(true, at: base.addingTimeInterval(1)), uptime: 1)
        driver.chunker.handle(Synthetic.raw(.keyUp, at: base.addingTimeInterval(2), source: 504, code: 7), uptime: 1)
        driver.chunker.handle(Synthetic.raw(.mouseMoved, at: base.addingTimeInterval(2.5), target: 502, source: 504,
                                            x: 9, y: 9), uptime: 1)
        driver.chunker.handle(Synthetic.raw(.leftMouseUp, at: base.addingTimeInterval(2.6), target: 502), uptime: 1)
        driver.chunker.lost(2, at: base.addingTimeInterval(3))
        let rebuilt = try XCTUnwrap(InputEventFiles.rebuild(try Data(contentsOf: openChunk)))
        driver.chunker.finish(at: base.addingTimeInterval(3))
        let closed = try InputEventCodec.chunk(try lines(openBatch)[0])
        XCTAssertEqual(rebuilt.at, closed.at)
        XCTAssertEqual(rebuilt.layout, closed.layout)
        XCTAssertEqual(rebuilt.apps, closed.apps)
        XCTAssertEqual(rebuilt.events, Array(closed.events.dropLast()), "everything but the log_stop written after")
        XCTAssertEqual(rebuilt.lost, closed.lost)
        XCTAssertTrue(rebuilt.recovered)
        XCTAssertEqual(rebuilt.until, UTCInstant.millisecond(base.addingTimeInterval(2.6)), "a recovered chunk ends at its last event")
        XCTAssertTrue(rebuilt.events.contains { event in
            if case .move(let move) = event.body { return move.syn != nil }
            return false
        }, "a posted move keeps its poster through recovery")
    }


    func testLaunchRebuildsTheOpenMinuteDroppingATornLastLineAndSealsTheBatch() throws {
        let driver = ChunkerOnFiles(files: try openFiles(), zone: zone)
        driver.chunker.handle(Synthetic.raw(.leftMouseUp, at: Synthetic.opened.addingTimeInterval(2)), uptime: 0)
        driver.chunker.handle(Synthetic.raw(.leftMouseUp, at: Synthetic.opened.addingTimeInterval(4)), uptime: 0)
        let torn = try Data(contentsOf: openChunk) + Data(#"{"t":6000,"e":"up","butt"#.utf8)
        try torn.write(to: openChunk)

        let reopened = try openFiles()
        XCTAssertEqual(reopened.sealedBatches(), ["20260923T100230.000Z.jsonl"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: openChunk.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: openBatch.path))
        let sealed = try lines(folder.appendingPathComponent("20260923T100230.000Z.jsonl"))
        XCTAssertEqual(sealed.count, 1)
        XCTAssertTrue(sealed[0].hasSuffix(#","recovered":true}"#))
        let chunk = try InputEventCodec.chunk(sealed[0])
        XCTAssertEqual(chunk.events.map(\.t), [0, 2000, 4000])
        XCTAssertEqual(chunk.until, Synthetic.opened.addingTimeInterval(4))
        XCTAssertTrue(chunk.recovered)
    }

    func testTheRecoveredMinuteJoinsTheBatchTheLastRunLeftOpen() throws {
        let driver = ChunkerOnFiles(files: try openFiles(), zone: zone)
        driver.chunker.handle(Synthetic.raw(.leftMouseUp, at: Synthetic.opened.addingTimeInterval(2)), uptime: 0)
        driver.chunker.tick(now: Synthetic.minute, uptime: 0)
        driver.chunker.handle(Synthetic.raw(.leftMouseUp, at: Synthetic.minute.addingTimeInterval(9)), uptime: 0)
        driver.syncIfNeeded()

        let reopened = try openFiles()
        XCTAssertEqual(reopened.sealedBatches(), ["20260923T100230.000Z.jsonl"])
        let sealed = try lines(folder.appendingPathComponent("20260923T100230.000Z.jsonl"))
        XCTAssertEqual(sealed.count, 2)
        XCTAssertFalse(try InputEventCodec.chunk(sealed[0]).recovered)
        XCTAssertEqual(try InputEventCodec.chunk(sealed[1]).at, Synthetic.minute)
        XCTAssertTrue(try InputEventCodec.chunk(sealed[1]).recovered)
    }

    func testAMinuteWhoseLineWasPublishedBeforeTheCrashIsNotRecoveredTwice() throws {
        let files = try openFiles()
        let published = chunk(at: "2026-09-23T10:03:00.000Z")
        files.chunkOpened(at: published.at, layout: published.layout)
        files.appAdded(0, name: Synthetic.editor)
        for event in published.events { files.eventFinished(event) }
        try files.publish(published)

        let reopened = try openFiles()
        let sealed = try lines(folder.appendingPathComponent(try XCTUnwrap(reopened.sealedBatches().first)))
        XCTAssertEqual(sealed.count, 1)
        XCTAssertEqual(try InputEventCodec.chunk(sealed[0]), published)
    }

    func testAMinuteAlreadyInTheNewestSealedBatchIsNotRecoveredTwice() throws {
        let files = try openFiles()
        let published = chunk(at: "2026-09-23T10:03:00.000Z")
        files.chunkOpened(at: published.at, layout: published.layout)
        files.appAdded(0, name: Synthetic.editor)
        for event in published.events { files.eventFinished(event) }
        try files.publish(published)
        try files.seal()

        let reopened = try openFiles()
        XCTAssertEqual(reopened.sealedBatches().count, 1)
    }

    func testAnOpenMinuteWithNoWholeEventIsDropped() throws {
        _ = try openFiles()
        try Data(#"{"chunk":"2026-09-23T10:03:00.000Z","layout":"com.apple.keylayout.US"}"#.utf8 + [0x0A]
                 + Array(#"{"t":1,"e":"lo"#.utf8)).write(to: openChunk)
        let reopened = try openFiles()
        XCTAssertEqual(reopened.sealedBatches(), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: openChunk.path))
        try Data(#"{"chunk":"2026-09-23T10:0"#.utf8).write(to: openChunk)
        XCTAssertEqual(try openFiles().sealedBatches(), [])
    }


    func testLaunchSealsAStaleBatchDroppingItsTornLastLine() throws {
        _ = try openFiles()
        let whole = try InputEventCodec.line(chunk(at: "2026-09-23T10:03:00.000Z")) + "\n"
        try Data((whole + #"{"at":"2026-09-23T10:04:00.000Z","until":"#).utf8).write(to: openBatch)
        let reopened = try openFiles()
        XCTAssertEqual(reopened.sealedBatches(), ["20260923T100300.000Z.jsonl"])
        XCTAssertEqual(try String(contentsOf: folder.appendingPathComponent("20260923T100300.000Z.jsonl"),
                                  encoding: .utf8), whole)
    }

    func testLaunchParksABatchWhoseFirstLineIsTornOutsideTheShipperSet() throws {
        _ = try openFiles()
        try Data(#"{"at":"2026-09-23T10:03:00.000Z","until":"#.utf8).write(to: openBatch)
        let reopened = try openFiles()
        XCTAssertEqual(reopened.sealedBatches(), [])
        let names = try FileManager.default.contentsOfDirectory(atPath: folder.path)
        XCTAssertEqual(names.count, 1)
        XCTAssertTrue(names[0].hasPrefix("current.jsonl.torn-"))
        XCTAssertFalse(names[0].hasSuffix(".jsonl"))
    }

    func testAnEmptyStaleBatchIsRemovedRatherThanSealed() throws {
        _ = try openFiles()
        FileManager.default.createFile(atPath: openBatch.path, contents: Data())
        XCTAssertEqual(try openFiles().sealedBatches(), [])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), [])
    }


    func testABatchIsSealedAtFourInTheMorningLocalUnderItsFirstLine() throws {
        let files = try openFiles()
        try files.publish(chunk(at: "2026-09-22T22:28:00.000Z"))
        try files.publish(chunk(at: "2026-09-22T22:29:00.000Z"))
        XCTAssertEqual(files.sealedBatches(), ["20260922T222800.000Z.jsonl"], "a chunk ending at 04:00 seals its batch")
        try files.publish(chunk(at: "2026-09-22T22:30:00.000Z"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: openBatch.path))
        try files.sealIfDue(now: Synthetic.date("2026-09-23T22:29:59.999Z"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: openBatch.path))
        try files.sealIfDue(now: Synthetic.date("2026-09-23T22:30:00.000Z"))
        XCTAssertEqual(files.sealedBatches(), ["20260922T222800.000Z.jsonl", "20260922T223000.000Z.jsonl"])
        XCTAssertEqual(InputEventBatch.sealedBatches(in: folder), files.sealedBatches())
    }

    func testAChunkOfALaterDaySealsTheOpenBatchFirst() throws {
        let files = try openFiles()
        try files.publish(chunk(at: "2026-09-22T20:00:00.000Z"))
        try files.publish(Self.pinnedChunk)
        XCTAssertEqual(files.sealedBatches(), ["20260922T200000.000Z.jsonl"])
        XCTAssertEqual(try lines(openBatch), [Self.pinnedLine])
        XCTAssertEqual(try InputEventCodec.chunk(try lines(openBatch)[0]), Self.pinnedChunk)
    }

    func testEveryEventKindPublishesItsPinnedBytes() throws {
        let driver = ChunkerOnFiles(files: try openFiles(), zone: zone)
        let chunker = driver.chunker
        let shift: UInt64 = 0x0002_0000
        let cmd: UInt64 = 0x0010_0000
        func at(_ seconds: Double) -> Date { Synthetic.opened.addingTimeInterval(seconds) }
        chunker.handle(.activate(pid: 502, name: Synthetic.browser, at: at(0.1)), uptime: 0)
        chunker.handle(Synthetic.raw(.mouseMoved, at: at(0.2), target: 502, x: 10.25, y: 20), uptime: 0)
        chunker.handle(Synthetic.raw(.mouseMoved, at: at(0.25), target: 502, source: 504, x: 11, y: 21), uptime: 0)
        chunker.handle(Synthetic.raw(.leftMouseDragged, at: at(0.3), target: 502, x: 12.5, y: -3.7), uptime: 0)
        chunker.handle(Synthetic.raw(.scrollWheel, at: at(0.5), target: 502, x: 300, y: 200, dx: 0.3, dy: -12.5,
                                     phase: 1, continuous: false), uptime: 0)
        chunker.handle(Synthetic.raw(.scrollWheel, at: at(0.56), target: 502, x: 300, y: 200, dy: 4, phase: 2,
                                     continuous: false), uptime: 0)
        chunker.handle(Synthetic.raw(.scrollWheel, at: at(0.6), target: 502, x: 300, y: 200, dy: 2.5, momentum: 1),
                       uptime: 0)
        chunker.handle(Synthetic.raw(.flagsChanged, at: at(0.8), code: 56, flags: shift | cmd), uptime: 0)
        chunker.handle(Synthetic.raw(.keyDown, at: at(0.9), code: 36, characters: "\r", flags: cmd), uptime: 0)
        chunker.resolve(try XCTUnwrap(driver.lookups.requests.last?.id),
                        Synthetic.element(role: "AXTextArea", title: "Say \"hi\"\tnow, caf\u{e9}"), ms: 4)
        chunker.handle(Synthetic.raw(.keyUp, at: at(1.0), code: 36), uptime: 0)
        chunker.handle(Synthetic.raw(.keyDown, at: at(1.05), code: 0, characters: "A", flags: shift), uptime: 0)
        chunker.resolve(try XCTUnwrap(driver.lookups.requests.last?.id), .failed(.noElement), ms: 150)
        chunker.handle(Synthetic.raw(.keyUp, at: at(1.07), code: 0), uptime: 0)
        chunker.handle(Synthetic.raw(.leftMouseDown, at: at(1.1), target: 502, x: 640.5, y: 88, clicks: 2), uptime: 0)
        chunker.resolve(try XCTUnwrap(driver.lookups.requests.last?.id), .found(
            InputElementAttributes(role: "AXButton", title: "\u{dc}n\u{ef}code \u{2713}", desc: "line\nbreak\\end",
                                   id: "go-1"),
            action: InputElementAttributes(role: "AXLink", url: "https://example.com/a?b=\"c\"")), ms: 3)
        chunker.handle(Synthetic.raw(.leftMouseUp, at: at(1.2), target: 502, x: 640.5, y: 88, clicks: 2), uptime: 0)
        chunker.handle(.layout("com.example.keylayout.\"Fake\"\u{1}", at: at(1.3)), uptime: 0)
        chunker.handle(.secureInput(true, at: at(1.4)), uptime: 0)
        chunker.handle(.secureInput(false, at: at(1.5)), uptime: 0)
        chunker.handle(.tapRestart(.timeout, at: at(1.6)), uptime: 0)
        chunker.lost(3, at: at(1.7))
        chunker.finish(at: at(2))
        XCTAssertEqual(try lines(openBatch), [Self.everyKindLine])
    }

    private static let everyKindLine = #"{"at":"2026-09-23T10:02:30.000Z","until":"2026-09-23T10:02:32.000Z","layout":"com.apple.keylayout.US","apps":["com.example.browser","com.example.agent","com.example.editor"],"events":[{"t":0,"e":"log_start","input_monitoring":true,"accessibility":true},{"t":100,"e":"activate","app":0,"pid":502},{"t":200,"e":"move","x":10.3,"y":20,"app":0},{"t":250,"e":"move","x":11,"y":21,"app":0,"syn":1},{"t":300,"e":"move","x":12.5,"y":-3.7,"drag":"left","app":0},{"t":500,"e":"scroll","x":300,"y":200,"dx":0.3,"dy":-12.5,"lines":true,"phase":"began","app":0},{"t":560,"e":"scroll","x":300,"y":200,"dx":0,"dy":4,"lines":true,"phase":"changed","app":0},{"t":600,"e":"scroll","x":300,"y":200,"dx":0,"dy":2.5,"phase":"momentum","app":0},{"t":800,"e":"flags","code":56,"mods":["cmd","shift"]},{"t":900,"e":"key_down","code":36,"name":"return","mods":["cmd"],"app":2,"el":{"ms":4,"role":"AXTextArea","title":"Say \"hi\"\tnow, café"}},{"t":1000,"e":"key_up","code":36,"app":2},{"t":1050,"e":"key_down","code":0,"key":"A","mods":["shift"],"app":2,"el":{"err":"none","ms":150}},{"t":1070,"e":"key_up","code":0,"app":2},{"t":1100,"e":"down","button":"left","x":640.5,"y":88,"clicks":2,"app":0,"el":{"action":{"role":"AXLink","url":"https://example.com/a?b=\"c\""},"desc":"line\nbreak\\end","id":"go-1","ms":3,"role":"AXButton","title":"Ünïcode ✓"}},{"t":1200,"e":"up","button":"left","x":640.5,"y":88,"clicks":2,"app":0},{"t":1300,"e":"layout","id":"com.example.keylayout.\"Fake\"\u0001"},{"t":1400,"e":"secure_input","on":true},{"t":1500,"e":"secure_input","on":false},{"t":1600,"e":"tap_restart","reason":"timeout"},{"t":2000,"e":"log_stop"}],"lost":3}"#

    func testAChunkWithSitesAndActivityPublishesItsPinnedLine() throws {
        let chunk = InputChunk(at: Synthetic.minute, until: Synthetic.minute.addingTimeInterval(60),
            layout: "com.apple.keylayout.US", apps: ["com.google.Chrome"], sites: ["news.example", "chat.example"],
            events: [InputEvent(t: 1, body: .activate(app: 0, pid: 510), site: 0),
                     InputEvent(t: 2, body: .keyUp(code: 4, app: 0, syn: nil), site: 0),
                     InputEvent(t: 3, body: .siteUnknown(on: true))],
            activity: [InputActivity(app: 0, site: 1, keys: 3), InputActivity(app: 0, clicks: 1)])
        let files = try openFiles()
        try files.publish(chunk)
        let line = try XCTUnwrap(try lines(openBatch).first)
        XCTAssertEqual(line, #"{"at":"2026-09-23T10:03:00.000Z","until":"2026-09-23T10:04:00.000Z","layout":"com.apple.keylayout.US","apps":["com.google.Chrome"],"sites":["news.example","chat.example"],"events":[{"t":1,"e":"activate","app":0,"site":0,"pid":510},{"t":2,"e":"key_up","code":4,"app":0,"site":0},{"t":3,"e":"site_unknown","on":true}],"activity":[{"app":0,"keys":0,"clicks":1,"scrolls":0,"moves":0},{"app":0,"site":1,"keys":3,"clicks":0,"scrolls":0,"moves":0}]}"#)
        let read = try InputEventCodec.chunk(line)
        XCTAssertEqual(read.events, chunk.events)
        XCTAssertEqual(read.sites, chunk.sites)
    }

    func testRecoveryRebuildsTheActivityCountsOfTheOpenMinute() throws {
        let files = try openFiles()
        let chunker = InputChunker(modes: RecordingModes(activity: ["com.example.chat"]), timeZone: zone,
                                   names: InputProcessNames { $0 == 505 ? "com.example.chat" : Synthetic.pids[$0] },
                                   writer: files, lookups: FakeLookups())
        chunker.open(at: Synthetic.opened, state: Synthetic.state())
        let base = Synthetic.opened.addingTimeInterval(1)
        for index in 0..<3 {
            chunker.handle(Synthetic.raw(.keyDown, at: base.addingTimeInterval(Double(index) * 0.1), target: 505,
                                         code: 0), uptime: 1)
        }
        chunker.handle(Synthetic.raw(.leftMouseDown, at: base.addingTimeInterval(1), target: 505), uptime: 1)
        let open = try String(contentsOf: openChunk, encoding: .utf8)
        XCTAssertTrue(open.contains(#"{"activity":0,"keys":3,"clicks":0,"scrolls":0,"moves":0}"#))
        XCTAssertFalse(open.contains(#""e":"key_down""#))
        let reopened = try openFiles()
        let sealed = try XCTUnwrap(reopened.sealedBatches().first)
        let chunk = try InputEventCodec.chunk(try XCTUnwrap(try lines(folder.appendingPathComponent(sealed)).first))
        XCTAssertTrue(chunk.recovered)
        XCTAssertEqual(chunk.apps, ["com.example.chat"])
        XCTAssertEqual(chunk.activity, [InputActivity(app: 0, keys: 3, clicks: 1)])
        XCTAssertEqual(chunk.events.map(\.body.name), [.logStart])
    }

    func testRecoveryRebuildsTheSitesAndTheSiteCounts() throws {
        var modes = RecordingModes.defaults
        try modes.setSite(.exclude, for: "bank.example")
        try modes.setSite(.activity, for: "chat.example")
        let chrome = "com.google.Chrome"
        let files = try openFiles()
        let chunker = InputChunker(modes: modes, timeZone: zone,
                                   names: InputProcessNames { $0 == 510 ? chrome : Synthetic.pids[$0] },
                                   writer: files, lookups: FakeLookups())
        chunker.open(at: Synthetic.opened, state: Synthetic.state())
        let base = Synthetic.opened.addingTimeInterval(1)
        func read(_ rule: String) -> InputPageRead { .page(.site(Site(rule: rule)!)) }
        chunker.handle(.page(pid: 510, read: read("news.example:443"), at: base), uptime: 1)
        chunker.handle(Synthetic.raw(.keyUp, at: base.addingTimeInterval(0.1), target: 510, code: 4), uptime: 1)
        chunker.handle(.page(pid: 510, read: read("chat.example:443"), at: base.addingTimeInterval(0.2)), uptime: 1)
        chunker.handle(Synthetic.raw(.leftMouseDown, at: base.addingTimeInterval(0.3), target: 510), uptime: 1)
        let open = try String(contentsOf: openChunk, encoding: .utf8)
        XCTAssertTrue(open.contains(#"{"site":0,"host":"news.example"}"#))
        XCTAssertTrue(open.contains(#"{"activity":0,"site":1,"keys":0,"clicks":1,"scrolls":0,"moves":0}"#))
        let reopened = try openFiles()
        let sealed = try XCTUnwrap(reopened.sealedBatches().first)
        let chunk = try InputEventCodec.chunk(try XCTUnwrap(try lines(folder.appendingPathComponent(sealed)).first))
        XCTAssertTrue(chunk.recovered)
        XCTAssertEqual(chunk.sites, ["news.example", "chat.example"])
        XCTAssertEqual(chunk.events.last?.site, 0)
        XCTAssertEqual(chunk.activity, [InputActivity(app: 0, site: 1, clicks: 1)])
    }

    func testTwoBatchesWhoseFirstLinesShareAMillisecondBothSurvive() throws {
        let files = try openFiles()
        try files.publish(chunk(at: "2026-09-23T10:03:00.000Z"))
        try files.seal()
        try files.publish(chunk(at: "2026-09-23T10:03:00.000Z"))
        try files.seal()
        try files.publish(chunk(at: "2026-09-23T10:03:00.000Z"))
        try files.seal()
        XCTAssertEqual(files.sealedBatches(), ["20260923T100300.000Z-2.jsonl", "20260923T100300.000Z-3.jsonl",
                                               "20260923T100300.000Z.jsonl"])
    }

    func testSealingAnEmptyBatchDoesNothing() throws {
        let files = try openFiles()
        try files.seal()
        XCTAssertEqual(files.sealedBatches(), [])
    }

    func testTheLastLineIsReadFromTheWholeBatch() throws {
        _ = try openFiles()
        let long = String(repeating: "x", count: 200_000)
        let text = "first\n\(long)\n{\"at\":\"2026-09-23T10:03:00.000Z\",\"until\"\n"
        try Data(text.utf8).write(to: openBatch)
        let batches = BatchFiles(DeviceFiles(.plain))
        XCTAssertEqual(batches.lastLine(openBatch), Data("{\"at\":\"2026-09-23T10:03:00.000Z\",\"until\"".utf8))
        XCTAssertNil(batches.lastLine(folder.appendingPathComponent("absent.jsonl")))
    }
}

final class ChunkerOnFiles {
    let files: InputEventFiles
    let lookups = FakeLookups()
    let chunker: InputChunker

    init(files: InputEventFiles, zone: TimeZone) {
        self.files = files
        chunker = InputChunker(modes: RecordingModes(), timeZone: zone, names: InputProcessNames { Synthetic.pids[$0] },
                               writer: files, lookups: lookups, after: files.lastUntil)
        chunker.open(at: Synthetic.opened, state: Synthetic.state())
    }

    func syncIfNeeded() {
        files.syncChunk()
    }
}

final class Space: @unchecked Sendable {
    private let lock = NSLock()
    private var held: Bool

    init(_ fits: Bool) { held = fits }

    var fits: Bool {
        get { lock.withLock { held } }
        set { lock.withLock { held = newValue } }
    }
}
