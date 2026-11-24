import CoreGraphics
import DeviceFiles
import Darwin
import Evidence
import Foundation
import XCTest
@testable import Screen

final class RecognitionHelperTests: XCTestCase {
    static let pace = RecognitionHelper.Pace(lift: 0.1, restart: 0.3, giveUp: 0.8, hold: 0.3, watch: 0.01)

    func testTheTextThroughThePipesIsTheTextReadInPlace() async throws {
        let image = try TileReuseTests.frame()
        let frame = try XCTUnwrap(ImageBytes.materialize(image))
        let fake = FakeVision()
        let helper = RecognitionHelper(pace: Self.pace, clock: { 0 }) { ServedHelper(recognize: { fake.read(crop: $0) }) }
        for tile in VisionRecognizer.tiles(width: image.width, height: image.height) {
            let piped = await helper.read(frame, tile)
            XCTAssertEqual(piped, fake.read(image, tile))
            XCTAssertNotNil(piped)
        }
        let tile = VisionRecognizer.tiles(width: image.width, height: image.height)[3]
        let request = try RecognitionWire.request(TileCrop(frame, tile), id: 7)
        let pipe = Pipe()
        let writing = Task.detached { FileDescriptors.write(pipe.fileHandleForWriting.fileDescriptor, request) }
        let (id, crop) = try XCTUnwrap(RecognitionWire.readRequest(pipe.fileHandleForReading.fileDescriptor))
        let wrote = await writing.value
        XCTAssertTrue(wrote)
        XCTAssertEqual(id, 7)
        XCTAssertEqual(crop.pixels, TileCrop(frame, tile).pixels)
        XCTAssertEqual(crop.tile.crop, tile.crop)
        XCTAssertEqual(crop.tile.core, tile.core)
        let rebuilt = try XCTUnwrap(crop.image())
        let cropped = try XCTUnwrap(image.cropping(to: tile.crop))
        XCTAssertEqual(rebuilt.width, cropped.width)
        XCTAssertEqual(rebuilt.bitmapInfo, cropped.bitmapInfo)
        XCTAssertEqual(rebuilt.renderingIntent, cropped.renderingIntent)
        XCTAssertTrue(CFEqual(rebuilt.colorSpace, cropped.colorSpace))
    }

    func testAMalformedOrOversizedRequestEndsTheHelper() throws {
        for request in [Data([0xFF, 0xFF, 0xFF, 0x7F]) + Data(repeating: 0x20, count: 16),
                        Data([0x05, 0, 0, 0]) + Data("{bad}".utf8)] {
            let input = Pipe(), output = Pipe()
            XCTAssertTrue(FileDescriptors.write(input.fileHandleForWriting.fileDescriptor, request))
            try input.fileHandleForWriting.close()
            var served = 0
            RecognitionHelperServer.serve(input: input.fileHandleForReading.fileDescriptor,
                                          output: output.fileHandleForWriting.fileDescriptor) { _ in
                served += 1
                return []
            }
            XCTAssertEqual(served, 0, "nothing malformed is read")
        }
    }

    func testReadsRunOneAtATimeInTheOrderAsked() async throws {
        let image = try TileReuseTests.frame()
        let frame = try XCTUnwrap(ImageBytes.materialize(image))
        let tiles = VisionRecognizer.tiles(width: image.width, height: image.height)
        let log = Log()
        let clock = HandClock()
        let gate = DispatchSemaphore(value: 0)
        let launched = Launched()
        endAtTeardown(launched, clock, gate)
        let helper = RecognitionHelper(pace: Self.pace, clock: { clock.now }) {
            launched.add(ServedHelper(stall: gate) { crop in
                gate.wait()
                gate.signal()
                log.begin(crop.tile.core)
                Thread.sleep(forTimeInterval: 0.01)
                log.end()
                return []
            })
        }
        let reads = tiles.enumerated().map { Asked(helper, frame, $1, as: $0) }
        try await until("clock.asked.count == tiles.count") { clock.asked.count == tiles.count }
        gate.signal()
        try await until("reads.allSatisfy(\\.answered)") { reads.allSatisfy(\.answered) }
        XCTAssertEqual(log.order, clock.asked.map { tiles[$0].core })
        XCTAssertEqual(log.mostAtOnce, 1)
    }

    func testALateReadLiftsTheHelperAndItGoesBackOnceCaughtUp() async throws {
        let image = try TileReuseTests.frame()
        let frame = try XCTUnwrap(ImageBytes.materialize(image))
        let tiles = VisionRecognizer.tiles(width: image.width, height: image.height)
        let clock = HandClock()
        let gate = DispatchSemaphore(value: 0)
        let launched = Launched()
        endAtTeardown(launched, clock, gate)
        let helper = RecognitionHelper(pace: Self.pace, clock: { clock.now }) {
            launched.add(ServedHelper(stall: gate) { _ in
                gate.wait()
                gate.signal()
                return []
            })
        }
        let reads = tiles.map { Asked(helper, frame, $0) }
        try await until("launched.all.first?.priorities.isEmpty == false") { launched.all.first?.priorities.isEmpty == false }
        let process = try XCTUnwrap(launched.all.first)
        XCTAssertEqual(process.priorities.first, true, "started on the efficiency cores")
        let lifted = Self.pace.lift
        clock.set(lifted)
        try await until("process.priorities.contains(false)") { process.priorities.contains(false) }
        gate.signal()
        try await until("reads.allSatisfy(\\.answered)") { reads.allSatisfy(\.answered) }
        XCTAssertEqual(process.priorities.last, false, "still lifted within `hold`")
        clock.set(lifted + Self.pace.hold)
        _ = try await answer(Asked(helper, frame, tiles[0]))
        let counts = await helper.counts
        XCTAssertEqual(process.priorities.last, true, "back on the efficiency cores once caught up past `hold`")
        XCTAssertEqual(counts.lifts, 1)
        XCTAssertEqual(launched.all.count, 1)
        XCTAssertEqual(counts.failed, 0)
    }

    func testAStalledOrDeadHelperIsEndedAndItsRequestSentToANewOne() async throws {
        let image = try TileReuseTests.frame()
        let frame = try XCTUnwrap(ImageBytes.materialize(image))
        let tile = VisionRecognizer.tiles(width: image.width, height: image.height)[0]
        let fake = FakeVision()
        for (first, stalls) in [(ServedHelper.stalled(), true), (ServedHelper.dead(), false)] {
            let clock = HandClock()
            let launched = Launched()
            endAtTeardown(launched, clock)
            let helper = RecognitionHelper(pace: Self.pace, clock: { clock.now }) {
                launched.all.isEmpty ? launched.add(first) : launched.add(ServedHelper(recognize: { fake.read(crop: $0) }))
            }
            let reading = Asked(helper, frame, tile)
            if stalls {
                try await until("first.reads == 1") { first.reads == 1 }
                clock.set(Self.pace.restart)
            }
            let text = try await answer(reading)
            XCTAssertEqual(text, fake.read(image, tile), "answered by the second helper, before `giveUp`")
            XCTAssertEqual(launched.all.count, 2)
            XCTAssertTrue(first.ended, "the first helper was ended")
            let counts = await helper.counts
            XCTAssertEqual(counts.restarts, 1)
            XCTAssertEqual(counts.failed, 0)
        }
    }

    func testAHelperStillWorkingIsNeverEndedForASlowRead() async throws {
        let image = try TileReuseTests.frame()
        let frame = try XCTUnwrap(ImageBytes.materialize(image))
        let tile = VisionRecognizer.tiles(width: image.width, height: image.height)[0]
        let fake = FakeVision()
        let pace = RecognitionHelper.Pace(lift: 0.5, restart: 0.2, giveUp: 1.5, hold: 0.3, watch: 0.01)
        for stalledFirst in [false, true] {
            let clock = HandClock()
            let gate = DispatchSemaphore(value: 0)
            let launched = Launched()
            endAtTeardown(launched, clock, gate)
            let helper = RecognitionHelper(pace: pace, clock: { clock.now }) {
                stalledFirst && launched.all.isEmpty ? launched.add(ServedHelper.stalled())
                    : launched.add(ServedHelper(working: true, stall: gate) {
                        gate.wait()
                        return fake.read(crop: $0)
                    })
            }
            let reading = Asked(helper, frame, tile)
            if stalledFirst {
                try await until("launched.all.first?.reads == 1") { launched.all.first?.reads == 1 }
                clock.set(pace.restart)
                try await until("launched.all.count == 2") { launched.all.count == 2 }
            }
            try await until("launched.all.last?.reads == 1") { launched.all.last?.reads == 1 }
            let working = try XCTUnwrap(launched.all.last)
            clock.set(clock.now + pace.lift)
            try await until("working.priorities.contains(false)") { working.priorities.contains(false) }
            _ = await helper.counts
            XCTAssertFalse(working.ended, "a helper using CPU is not ended for a read slower than `restart`")
            gate.signal()
            let text = try await answer(reading)
            XCTAssertEqual(text, fake.read(image, tile), "the slow read is waited for")
            XCTAssertEqual(launched.all.count, stalledFirst ? 2 : 1)
            XCTAssertFalse(working.ended)
            let counts = await helper.counts
            XCTAssertEqual(counts.restarts, stalledFirst ? 1 : 0)
            XCTAssertEqual(counts.failed, 0)
        }
    }

    func testAReadUnansweredAtGiveUpFailsAndTheWorkingHelperReadsOn() async throws {
        let image = try TileReuseTests.frame()
        let frame = try XCTUnwrap(ImageBytes.materialize(image))
        let tiles = VisionRecognizer.tiles(width: image.width, height: image.height)
        let fake = FakeVision()
        let pace = RecognitionHelper.Pace(lift: 0.1, restart: 5, giveUp: 1.0, hold: 0.3, watch: 0.01)
        let clock = HandClock()
        let turn = DispatchSemaphore(value: 0)
        let launched = Launched()
        endAtTeardown(launched, clock, turn)
        let helper = RecognitionHelper(pace: pace, clock: { clock.now }) {
            launched.add(ServedHelper(working: true) {
                turn.wait()
                return fake.read(crop: $0)
            })
        }
        let first = Asked(helper, frame, tiles[0], as: 0)
        try await until("launched.all.first?.reads == 1") { launched.all.first?.reads == 1 }
        let second = Asked(helper, frame, tiles[1], as: 1)
        try await until("clock.asked == [0, 1]") { clock.asked == [0, 1] }
        let third = Asked(helper, frame, tiles[2], as: 2)
        try await until("clock.asked == [0, 1, 2]") { clock.asked == [0, 1, 2] }
        turn.signal()
        let firstText = try await answer(first)
        let process = try XCTUnwrap(launched.all.first)
        try await until("process.reads == 2") { process.reads == 2 }
        clock.set(pace.giveUp)
        let (secondText, thirdText) = (try await answer(second), try await answer(third))
        XCTAssertEqual(firstText, fake.read(image, tiles[0]))
        XCTAssertNil(secondText)
        XCTAssertNil(thirdText)
        XCTAssertEqual(process.reads, 2, "answered at `giveUp`, not when the read ends; a queued read too, never sent")
        XCTAssertFalse(process.ended, "a helper still working is kept")
        let next = Asked(helper, frame, tiles[3])
        turn.signal()
        turn.signal()
        let nextText = try await answer(next)
        XCTAssertEqual(nextText, fake.read(image, tiles[3]))
        XCTAssertEqual(launched.all.count, 1)
        let counts = await helper.counts
        XCTAssertEqual(counts.failed, 2)
        XCTAssertEqual(counts.restarts, 0)
    }

    func testAStalledReadIsAnsweredAtGiveUpAndItsHelperEndedOnceIdleForRestart() async throws {
        let image = try TileReuseTests.frame()
        let frame = try XCTUnwrap(ImageBytes.materialize(image))
        let tile = VisionRecognizer.tiles(width: image.width, height: image.height)[0]
        let fake = FakeVision()
        let pace = RecognitionHelper.Pace(lift: 0.1, restart: 0.6, giveUp: 0.3, hold: 0.3, watch: 0.01)
        let clock = HandClock()
        let launched = Launched()
        endAtTeardown(launched, clock)
        let helper = RecognitionHelper(pace: pace, clock: { clock.now }) {
            launched.all.isEmpty ? launched.add(ServedHelper.stalled()) : launched.add(ServedHelper(recognize: { fake.read(crop: $0) }))
        }
        let reading = Asked(helper, frame, tile)
        try await until("launched.all.first?.reads == 1") { launched.all.first?.reads == 1 }
        let stalled = try XCTUnwrap(launched.all.first)
        clock.set(pace.lift)
        try await until("stalled.priorities.contains(false)") { stalled.priorities.contains(false) }
        let early = await helper.counts
        XCTAssertEqual(early.failed, 0, "not answered before `giveUp`")
        clock.set(pace.giveUp)
        let text = try await answer(reading)
        XCTAssertNil(text)
        XCTAssertFalse(stalled.ended, "answered at `giveUp`, not at `restart`")
        clock.set(pace.restart)
        try await until("stalled.ended") { stalled.ended }
        let next = try await answer(Asked(helper, frame, tile))
        XCTAssertEqual(next, fake.read(image, tile))
        XCTAssertEqual(launched.all.count, 2)
        XCTAssertEqual(launched.all.last?.reads, 1, "an answered read is not sent again")
        let counts = await helper.counts
        XCTAssertEqual(counts.failed, 1, "one failure, though the request ended twice")
        XCTAssertEqual(counts.restarts, 0, "an answered read is not sent again")
    }

    func testWithNoHelperAReadIsAnsweredNilAtOnceAndTheNextTriesAgain() async throws {
        let image = try TileReuseTests.frame()
        let frame = try XCTUnwrap(ImageBytes.materialize(image))
        let tiles = VisionRecognizer.tiles(width: image.width, height: image.height)
        let lines = try failureLines()
        let tries = Launched()
        let helper = RecognitionHelper(pace: Self.pace, clock: { 0 }, lines: lines.record) {
            tries.tried()
            return nil
        }
        let first = await helper.read(frame, tiles[2])
        XCTAssertNil(first)
        XCTAssertEqual(tries.attempts, 1)
        let second = await helper.read(frame, tiles[3])
        XCTAssertNil(second)
        XCTAssertEqual(tries.attempts, 2, "the next read tries to start a helper again")
        let counts = await helper.counts
        XCTAssertEqual(counts.failed, 2, "each frame publishes with its OCR failed")
        XCTAssertEqual(try lines.events(), ["helper_unavailable"], "one line a streak")
    }

    func testAHelperStartedOnTheSecondTryReadsTheSecondRead() async throws {
        let image = try TileReuseTests.frame()
        let frame = try XCTUnwrap(ImageBytes.materialize(image))
        let tile = VisionRecognizer.tiles(width: image.width, height: image.height)[2]
        let fake = FakeVision()
        let lines = try failureLines()
        let tries = Launched()
        let helper = RecognitionHelper(pace: Self.pace, clock: { 0 }, lines: lines.record) {
            tries.tried()
            return tries.attempts == 1 ? nil : tries.add(ServedHelper(recognize: { fake.read(crop: $0) }))
        }
        let first = await helper.read(frame, tile)
        XCTAssertNil(first)
        let second = await helper.read(frame, tile)
        XCTAssertEqual(second, fake.read(image, tile))
        XCTAssertNotNil(second)
        XCTAssertEqual(tries.all.first?.reads, 1, "the second read is the helper's")
        XCTAssertEqual(tries.attempts, 2)
        XCTAssertEqual(try lines.events(), ["helper_unavailable", "helper_back"])
        let back = try lines.read()[1]
        XCTAssertEqual(back["part"] as? String, "recognition")
        XCTAssertEqual(back["since"] as? String, try lines.read()[0]["at"] as? String, "the return carries the streak's start")
        addTeardownBlock { for served in tries.all { served.end() } }
    }

    func testEveryHelpersUseIsCountedEndedOnesIncluded() async throws {
        let image = try TileReuseTests.frame()
        let frame = try XCTUnwrap(ImageBytes.materialize(image))
        let tile = VisionRecognizer.tiles(width: image.width, height: image.height)[0]
        let launched = Launched()
        let helper = RecognitionHelper(pace: Self.pace, clock: { 0 }) {
            launched.all.isEmpty ? launched.add(ServedHelper.dead(cpuNs: 5_000)) : launched.add(ServedHelper(cpuNs: 7_000) { _ in [] })
        }
        _ = await helper.read(frame, tile)
        XCTAssertEqual(helper.usage().cpuNs, 12_000, "the ended helper's last read and the running one's")
    }

    private func endAtTeardown(_ launched: Launched, _ clock: HandClock, _ gates: DispatchSemaphore...) {
        addTeardownBlock {
            clock.set(1e9)
            for gate in gates { for _ in 0..<64 { gate.signal() } }
            for helper in launched.all { helper.end() }
        }
    }

    private func failureLines() throws -> NotedLines {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("helper-lines-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let record = FailureLines()
        record.configure(spool: root, plain: DeviceFiles(.plain), build: "b", pid: 1)
        return NotedLines(record: record, folder: root.appendingPathComponent("resources"))
    }

    private func answer(_ read: Asked) async throws -> [TextObservation]? {
        try await until("read.answered") { read.answered }
        return read.text
    }
}


final class ServedHelper: HelperProcess, @unchecked Sendable {
    private let lock = NSLock()
    private let client: Int32
    private let server: Int32
    private var background: [Bool] = []
    private var done = false
    private let cpuNs: UInt64
    private let working: Bool
    private let born = DispatchTime.now().uptimeNanoseconds
    private let stall: DispatchSemaphore?
    private var begun = 0

    var priorities: [Bool] { lock.withLock { background } }
    var ended: Bool { lock.withLock { done } }
    var reads: Int { lock.withLock { begun } }

    init(cpuNs: UInt64 = 1, working: Bool = false, stall: DispatchSemaphore? = nil,
         recognize: @escaping @Sendable (TileCrop) -> [TextObservation]?) {
        self.cpuNs = cpuNs
        self.working = working
        self.stall = stall
        var pair: [Int32] = [-1, -1]
        precondition(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0)
        for descriptor in pair {
            var on: Int32 = 1
            setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        }
        client = pair[0]
        server = pair[1]
        Thread.detachNewThread { [self] in
            RecognitionHelperServer.serve(input: server, output: server) { crop in
                lock.withLock { begun += 1 }
                return recognize(crop)
            }
        }
    }

    deinit {
        close(client)
        close(server)
    }

    static func stalled() -> ServedHelper {
        let gate = DispatchSemaphore(value: 0)
        return ServedHelper(stall: gate) { _ in
            gate.wait()
            return nil
        }
    }

    static func dead(cpuNs: UInt64 = 1) -> ServedHelper {
        let helper = ServedHelper(cpuNs: cpuNs) { _ in nil }
        shutdown(helper.server, SHUT_RDWR)
        return helper
    }

    func exchange(_ request: Data) -> RecognitionWire.Reply? {
        guard FileDescriptors.write(client, request) else { return nil }
        return RecognitionWire.readReply(client)
    }

    func setBackground(_ background: Bool) {
        lock.withLock { self.background.append(background) }
    }

    func end() {
        let first = lock.withLock { () -> Bool in
            defer { done = true }
            return !done
        }
        guard first else { return }
        shutdown(server, SHUT_RDWR)
        stall?.signal()
    }

    func usage() -> ProcessUsage? {
        var usage = ProcessUsage()
        usage.cpuNs = cpuNs + (working ? DispatchTime.now().uptimeNanoseconds - born : 0)
        return usage
    }
}

private final class HandClock: @unchecked Sendable {
    @TaskLocal static var asking: Int?
    private let lock = NSLock()
    private var seconds = 0.0
    private var seen: [Int] = []

    var now: Double {
        let read = Self.asking
        return lock.withLock {
            if let read, !seen.contains(read) { seen.append(read) }
            return seconds
        }
    }

    var asked: [Int] { lock.withLock { seen } }

    func set(_ seconds: Double) {
        lock.withLock { self.seconds = seconds }
    }
}

private final class Asked: @unchecked Sendable {
    private let lock = NSLock()
    private var answer: [TextObservation]??

    init(_ helper: RecognitionHelper, _ frame: RawFrame, _ tile: Tile, as read: Int? = nil) {
        Task { [self] in
            let text = await HandClock.$asking.withValue(read) { await helper.read(frame, tile) }
            lock.withLock { answer = .some(text) }
        }
    }

    var answered: Bool { lock.withLock { answer != nil } }
    var text: [TextObservation]? { lock.withLock { answer ?? nil } }
}

private struct NotedLines {
    let record: FailureLines
    let folder: URL

    func read() throws -> [[String: Any]] {
        record.drain()
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        return try names.sorted().flatMap { name in
            try String(contentsOf: folder.appendingPathComponent(name), encoding: .utf8).split(separator: "\n").map {
                try XCTUnwrap(try JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])
            }
        }
    }

    func events() throws -> [String?] { try read().map { $0["event"] as? String } }
}

private final class Launched: @unchecked Sendable {
    private let lock = NSLock()
    private var helpers: [ServedHelper] = []
    private var tries = 0

    var all: [ServedHelper] { lock.withLock { helpers } }
    var attempts: Int { lock.withLock { tries } }

    func tried() {
        lock.withLock { tries += 1 }
    }

    func add(_ helper: ServedHelper) -> ServedHelper {
        lock.withLock { helpers.append(helper) }
        return helper
    }
}

private final class Log: @unchecked Sendable {
    private let lock = NSLock()
    private var running = 0
    private(set) var mostAtOnce = 0
    private(set) var order: [CGRect] = []

    func begin(_ core: CGRect) {
        lock.withLock {
            order.append(core)
            running += 1
            mostAtOnce = max(mostAtOnce, running)
        }
    }

    func end() {
        lock.withLock { running -= 1 }
    }
}
