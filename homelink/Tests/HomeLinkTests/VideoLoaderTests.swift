import AVFoundation
import CoreVideo
import Foundation
import XCTest
@testable import HomeLink

final class VideoLoaderTests: XCTestCase {
    private var folder: URL!
    private let phone = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone", serial4: nil)

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("homelink-video-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private static let large: Data = {
        var bytes = Data((0..<251).map { UInt8($0) })
        while bytes.count < 40 << 20 { bytes.append(bytes) }
        return bytes.prefix((40 << 20) + 1_000)
    }()

    private func streamer(_ door: RangedDoor, type: String = "video/quicktime") async throws -> VideoLoader {
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: "https://lifestream.example.ts.net", account: Fixture.account)
        let link = HomeLink(device: phone, credentials: credentials, folder: folder, transport: door)
        return VideoLoader(link: link, play: .init(hash: door.hash, mediaType: type, live: false))
    }

    private static func ranges(from offset: Int64, to end: Int64) -> [Range<Int64>] {
        var (ranges, at, size) = ([Range<Int64>](), offset, VideoLoader.first)
        while at < end {
            ranges.append(at..<min(at + size, end))
            at += size
            size = min(size * 2, VideoLoader.range)
        }
        return ranges
    }

    func testAnAllToEndRequestIsAskedFromAQuarterMiBDoublingToFourMiBOneAtOnceAndToldTheFactsType() async throws {
        let door = RangedDoor(Self.large)
        let loader = try await streamer(door)
        let request = Loading(offset: 0, end: nil, informs: true)
        await loader.serve(request)?.value
        let kib: Int64 = 1 << 10
        let asked = door.asked
        XCTAssertEqual(asked.prefix(6).map(\.count), [256 * kib, 512 * kib, 1_024 * kib, 2_048 * kib, 4_096 * kib, 4_096 * kib].map(Int.init),
                       "a quarter MiB first, doubling to 4 MiB")
        XCTAssertEqual(asked.dropLast(), Self.ranges(from: 0, to: Int64(Self.large.count)).dropLast()[...], "in order, none skipped")
        XCTAssertGreaterThanOrEqual(asked.last?.upperBound ?? 0, Int64(Self.large.count), "the last past the file")
        XCTAssertEqual(door.most, 1, "never two ranges at once")
        XCTAssertEqual(request.received, Self.large, "the file, in order")
        XCTAssertTrue(request.finished)
        XCTAssertNil(request.failure)
        XCTAssertEqual(request.informed?.type, "com.apple.quicktime-movie", "the facts' type, never the door's octet-stream")
        XCTAssertEqual(request.informed?.length, Int64(Self.large.count))
        XCTAssertEqual(door.paths, Set(["/v1/blobs/" + door.hash]))
    }

    func testASeekIsAskedFromItsOffsetAndATailReadExactlyToTheEnd() async throws {
        let door = RangedDoor(Self.large)
        let loader = try await streamer(door)
        let total = Int64(Self.large.count)
        let seek = Loading(offset: 10_000_005, end: 10_000_005 + 5 << 20)
        await loader.serve(seek)?.value
        XCTAssertEqual(door.asked, Self.ranges(from: 10_000_005, to: 10_000_005 + 5 << 20))
        XCTAssertEqual(seek.received, Self.large[10_000_005..<10_000_005 + 5 << 20])
        XCTAssertTrue(seek.finished)
        let seeking = door.asked.count

        let tail = Loading(offset: total - 1_000, end: total)
        await loader.serve(tail)?.value
        XCTAssertEqual(door.asked.last, total - 1_000..<total, "the movie header at the end, asked as it is")
        XCTAssertEqual(tail.received, Self.large.suffix(1_000))
        XCTAssertTrue(tail.finished)

        let information = Loading(offset: nil, end: nil, informs: true)
        await loader.serve(information)?.value
        XCTAssertEqual(information.informed?.length, total, "the length an answer already said")
        XCTAssertEqual(door.asked.count, seeking + 1, "a request for the content information alone asks nothing once the length is known")
        XCTAssertTrue(information.finished)
        XCTAssertTrue(information.received.isEmpty)
    }

    func testTheContentInformationAloneAsksOneByte() async throws {
        let door = RangedDoor(Self.large)
        let loader = try await streamer(door, type: "video/mp4")
        let information = Loading(offset: nil, end: nil, informs: true)
        await loader.serve(information)?.value
        XCTAssertEqual(door.asked, [0..<1])
        XCTAssertEqual(information.informed?.type, "public.mpeg-4")
        XCTAssertEqual(information.informed?.length, Int64(Self.large.count))
        XCTAssertTrue(information.received.isEmpty, "only the information was asked")
        XCTAssertTrue(information.finished)
    }

    func testACancelledRequestAsksNoRangeAfterAndIsNeverAnswered() async throws {
        let door = RangedDoor(Self.large, hold: 1)
        let loader = try await streamer(door)
        let request = Loading(offset: 0, end: nil, informs: true)
        let chain = try XCTUnwrap(loader.serve(request))
        await fulfillment(of: [door.held], timeout: 30)
        loader.cancel(request)
        await chain.value
        XCTAssertEqual(door.asked.count, 2, "the second range was in flight; no third is asked")
        XCTAssertEqual(Int64(request.received.count), VideoLoader.first, "the first range alone")
        XCTAssertFalse(request.finished)
        XCTAssertNil(request.failure)

        let leaving = RangedDoor(Self.large, hold: 0)
        let left = try await streamer(leaving)
        let playing = Loading(offset: 0, end: nil)
        let stream = try XCTUnwrap(left.serve(playing))
        await fulfillment(of: [leaving.held], timeout: 30)
        left.cancel()
        await stream.value
        XCTAssertEqual(leaving.asked.count, 1)
        XCTAssertTrue(playing.received.isEmpty)
        XCTAssertFalse(playing.finished)
        XCTAssertNil(playing.failure)
        XCTAssertNil(left.serve(Loading(offset: 0, end: 100)), "a page left takes no request")
        XCTAssertEqual(leaving.asked.count, 1)
    }

    func testAMalformedOrShortAnswerEndsTheRequestWithAnError() async throws {
        let first = Int(VideoLoader.first), second = 2 * Int(VideoLoader.first)
        let wrong: [(String, (Range<Int64>) -> HomeResponse, LinkFailure, Int)] = [
            ("the whole file", { _ in HomeResponse(status: 200, body: Self.large) }, .unreadable(200), first),
            ("a short body", { range in
                let start = Int(range.lowerBound), end = Int(range.upperBound) - 1
                return HomeResponse(status: 206, headers: ["Content-Range": "bytes \(start)-\(end)/\(Self.large.count)"],
                                    body: Self.large[start..<end])
            }, .unreadable(206), first + second - 1),
            ("another start", { range in
                let start = Int(range.lowerBound) + 1, end = Int(range.upperBound) - 1
                return HomeResponse(status: 206, headers: ["Content-Range": "bytes \(start)-\(end)/\(Self.large.count)"],
                                    body: Self.large[start...end])
            }, .unreadable(206), first),
            ("a 416 mid-file", { _ in HomeResponse(status: 416, headers: ["Content-Range": "bytes */\(Self.large.count)"], body: Data()) },
             .unreadable(416), first),
        ]
        for (what, answer, failure, handed) in wrong {
            try? FileManager.default.removeItem(at: folder)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let door = RangedDoor(Self.large, otherwise: (1, answer))
            let loader = try await streamer(door)
            let request = Loading(offset: 0, end: nil)
            await loader.serve(request)?.value
            XCTAssertEqual(request.failure as? LinkFailure, failure, what)
            XCTAssertFalse(request.finished, what)
            XCTAssertEqual(request.received, Self.large.prefix(handed), "\(what): the file's bytes alone were handed on")
            XCTAssertEqual(door.asked.count, 2, "\(what): nothing asked after it")
        }
    }

    func testARequestAtTheEndFinishesWithNoBytes() async throws {
        let door = RangedDoor(Self.large)
        let loader = try await streamer(door)
        let total = Int64(Self.large.count)
        let request = Loading(offset: total, end: nil)
        await loader.serve(request)?.value
        XCTAssertEqual(door.asked, [total..<total + VideoLoader.first])
        XCTAssertTrue(request.finished, "a 416 at the end")
        XCTAssertNil(request.failure)
        XCTAssertTrue(request.received.isEmpty)
    }

    func testARealMovieOpensInAVFoundationThroughTheLoader() async throws {
        let movie = try await writtenMovie()
        let door = RangedDoor(movie)
        let loader = try await streamer(door)
        let (duration, playable) = try await loader.asset.load(.duration, .isPlayable)
        XCTAssertTrue(playable)
        XCTAssertEqual(duration.seconds, 2, accuracy: 0.1)
        let tracks = try await loader.asset.loadTracks(withMediaType: .video)
        XCTAssertEqual(tracks.count, 1)
        XCTAssertFalse(door.asked.isEmpty)
        XCTAssertTrue(door.asked.allSatisfy { $0.count <= VideoLoader.range })
        XCTAssertEqual(loader.asset.url.absoluteString, "lifestream-blob:" + door.hash)
    }

    func testAChainWaitsWhileThePlayerHoldsItsMarkAndReadsOnBelowIt() async throws {
        let door = RangedDoor(Self.large)
        let loader = try await streamer(door)
        loader.buffered(ahead: VideoLoader.ahead)
        let request = Loading(offset: 0, end: nil, informs: true)
        let chain = try XCTUnwrap(loader.serve(request))
        try await waitForPacing(loader)
        XCTAssertEqual(door.asked, [0..<VideoLoader.first], "the first range, then nothing while the player holds its mark")
        XCTAssertEqual(request.received, Self.large.prefix(Int(VideoLoader.first)))
        loader.buffered(ahead: VideoLoader.ahead + 5)
        XCTAssertEqual(loader.pacing, 1, "still at its mark")
        loader.buffered(ahead: VideoLoader.ahead - 1)
        await chain.value
        XCTAssertEqual(request.received, Self.large, "read on once the player held less")
        XCTAssertTrue(request.finished)

        let leaving = RangedDoor(Self.large)
        let left = try await streamer(leaving)
        left.buffered(ahead: VideoLoader.ahead)
        let waiting = Loading(offset: 0, end: nil)
        let stream = try XCTUnwrap(left.serve(waiting))
        try await waitForPacing(left)
        left.cancel()
        await stream.value
        XCTAssertEqual(leaving.asked.count, 1, "a page left asks nothing after")
        XCTAssertFalse(waiting.finished)
        XCTAssertNil(waiting.failure)
        XCTAssertEqual(left.pacing, 0)
    }

    private func waitForPacing(_ loader: VideoLoader) async throws {
        let ends = Date().addingTimeInterval(30)
        while loader.pacing != 1 {
            guard Date() < ends else {
                XCTFail("never paced in 30 s")
                return
            }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
    }


    private func doorway(_ answer: Doorway.Answer) async throws -> HomeLink {
        Doorway.reset(answer)
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: "https://lifestream.example.ts.net", account: Fixture.account)
        return HomeLink(device: phone, credentials: credentials, folder: folder, transport: URLSessionTransport(protocolClasses: [Doorway.self]))
    }

    func testAWholeFileAnsweredToARangeIsRefusedOnItsHeadersAndNeverReceived() async throws {
        let link = try await doorway(.whole)
        var handed = 0
        do {
            try await link.blob(Doorway.hash, range: 0..<1_000) { piece, _ in handed += piece.count }
            XCTFail("a 200 believed")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unreadable(200))
        }
        XCTAssertEqual(handed, 0)
        await fulfillment(of: [Doorway.stopped], timeout: 30)
    }

    func testARangeLongerThanAskedIsReadNoFurtherThanItsLength() async throws {
        let link = try await doorway(.longer)
        var handed = Data()
        do {
            try await link.blob(Doorway.hash, range: 0..<1_000) { piece, _ in handed += piece }
            XCTFail("a long range believed")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unreadable(206))
        }
        XCTAssertLessThanOrEqual(handed.count, 1_000, "nothing past the length asked")
        XCTAssertEqual(handed, Doorway.file.prefix(handed.count))
        await fulfillment(of: [Doorway.stopped], timeout: 30)
    }

    func testAFastOversizedRangeIsCutAtTheReceiverWhileItsReaderWaits() async throws {
        Doorway.reset(.flood)
        let transport = URLSessionTransport(protocolClasses: [Doorway.self])
        let request = HomeRequest(method: "GET", url: URL(string: "https://lifestream.example.ts.net/v1/blobs/" + Doorway.hash)!,
                                  headers: ["Range": "bytes=0-262143"], body: .empty, timeout: 30)
        let answer = try await transport.bytes(request) { status, _ in status == 206 ? 256 << 10 : nil }
        await fulfillment(of: [Doorway.stopped], timeout: 30)
        var queued = Data()
        do {
            for try await piece in answer.body { queued += piece }
            XCTFail("a flood read to its end")
        } catch is TooLong {}
        XCTAssertLessThanOrEqual(queued.count, 256 << 10, "nothing past the range taken in")
        XCTAssertEqual(queued, Doorway.flooded.prefix(queued.count), "what was taken, all of it, in order")
    }

    func testTheReceiverTakesNoMoreThanItsRangeAndQueuesNoMoreThanItsBound() async throws {
        let file = Data((0..<(2 << 20)).map { UInt8($0 % 251) })
        let size = 64 << 10, held = 256 << 10, most: Int64 = 1 << 20
        let task = Switches()
        let pieces = Pieces(most: most, held: held, pause: { task.flip("pause") }, go: { task.flip("go") }, stop: { task.flip("stop") })
        var sent = 0
        func send() {
            pieces.put(file[sent..<(sent + size)])
            sent += size
        }
        while task.said.isEmpty { send() }
        XCTAssertEqual(task.said, ["pause"])
        XCTAssertEqual(pieces.counts.queued, held, "paused as the queue reached its bound")
        send()
        XCTAssertEqual(pieces.counts.queued, held + size, "a piece in flight when it paused is taken, not dropped")
        var read = Data()
        let first = try await pieces.next()
        read += try XCTUnwrap(first)
        XCTAssertEqual(task.said, ["pause"], "at its bound still: no going again")
        let second = try await pieces.next()
        read += try XCTUnwrap(second)
        XCTAssertEqual(task.said, ["pause", "go"], "under its bound, the task goes again")
        while !task.said.contains("stop") { send() }
        XCTAssertEqual(pieces.counts.taken, most, "the range's bytes, and the piece that crossed them not taken")
        XCTAssertLessThanOrEqual(pieces.counts.queued, Int(most), "a network that sends on through a pause is held by the range")
        send()
        XCTAssertEqual(pieces.counts.taken, most, "nothing taken after its stop")
        XCTAssertEqual(task.said, ["pause", "go", "pause", "stop"], "paused again at its bound, stopped past the range")
        do {
            while let piece = try await pieces.next() { read += piece }
            XCTFail("an oversized answer read to its end")
        } catch is TooLong {}
        XCTAssertEqual(read, file.prefix(Int(most)), "every byte taken read, in order")
        XCTAssertEqual(pieces.counts.queued, 0)
    }

    func testARangesBytesAreHandedOnAsTheyArrive() async throws {
        let link = try await doorway(.halves)
        let first = XCTestExpectation(description: "the first half handed on")
        let received = Received()
        let read = Task {
            try await link.blob(Doorway.hash, range: 0..<1_000) { piece, total in
                XCTAssertEqual(total, Int64(Doorway.file.count))
                if received.add(piece) == 500 { first.fulfill() }
            }
        }
        await fulfillment(of: [first], timeout: 30)
        Doorway.rest()
        let total = try await read.value
        XCTAssertEqual(total, Int64(Doorway.file.count))
        XCTAssertEqual(received.bytes, Doorway.file.prefix(1_000))
    }

    private func writtenMovie() async throws -> Data {
        let url = folder.appendingPathComponent("synthetic.mov")
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 64, AVVideoHeightKey: 64,
        ])
        input.expectsMediaDataInRealTime = false
        let frames = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: 64, kCVPixelBufferHeightKey as String: 64,
        ])
        writer.add(input)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        let written = XCTestExpectation(description: "the movie written")
        let next = NSLock()
        nonisolated(unsafe) var frame = 0
        input.requestMediaDataWhenReady(on: DispatchQueue(label: "VideoLoaderTests.movie")) {
            while input.isReadyForMoreMediaData {
                let now = next.withLock { () -> Int in
                    defer { frame += 1 }
                    return frame
                }
                guard now < 60 else {
                    if now == 60 {
                        input.markAsFinished()
                        writer.finishWriting { written.fulfill() }
                    }
                    return
                }
                var buffer: CVPixelBuffer?
                CVPixelBufferCreate(nil, 64, 64, kCVPixelFormatType_32BGRA, nil, &buffer)
                guard let pixels = buffer else { continue }
                CVPixelBufferLockBaseAddress(pixels, [])
                memset(CVPixelBufferGetBaseAddress(pixels), Int32(now * 4), CVPixelBufferGetDataSize(pixels))
                CVPixelBufferUnlockBaseAddress(pixels, [])
                frames.append(pixels, withPresentationTime: CMTime(value: CMTimeValue(now), timescale: 30))
            }
        }
        await fulfillment(of: [written], timeout: 30)
        XCTAssertEqual(writer.status, .completed, writer.error.map { "\($0)" } ?? "")
        return try Data(contentsOf: url)
    }
}

private final class Loading: VideoLoader.Loading, @unchecked Sendable {
    let asked: (offset: Int64, end: Int64?)?
    let informs: Bool
    private let lock = NSLock()
    private var bytes = Data()
    private var told: (type: String?, length: Int64)?
    private var done = false
    private var failed: Error?

    init(offset: Int64?, end: Int64?, informs: Bool = false) {
        asked = offset.map { ($0, end) }
        self.informs = informs
    }

    var received: Data { lock.withLock { bytes } }
    var informed: (type: String?, length: Int64)? { lock.withLock { told } }
    var finished: Bool { lock.withLock { done } }
    var failure: Error? { lock.withLock { failed } }

    func inform(type: String?, length: Int64) {
        lock.withLock { told = (type, length) }
    }

    func respond(with data: Data) {
        lock.withLock {
            XCTAssertFalse(done || failed != nil, "answered after it ended")
            bytes.append(data)
        }
    }

    func finish() {
        lock.withLock {
            XCTAssertFalse(done || failed != nil, "ended twice")
            done = true
        }
    }

    func fail(_ error: Error) {
        lock.withLock {
            XCTAssertFalse(done || failed != nil, "ended twice")
            failed = error
        }
    }
}

private final class RangedDoor: HomeTransport, @unchecked Sendable {
    let file: Data
    let hash: String
    let held = XCTestExpectation(description: "the held range reached the door")
    private let hold: Int?
    private let otherwise: (Int, (Range<Int64>) -> HomeResponse)?
    private let lock = NSLock()
    private var ranges: [Range<Int64>] = []
    private var asking: Set<String> = []
    private var flying = 0
    private var peak = 0

    init(_ file: Data, hold: Int? = nil, otherwise: (Int, (Range<Int64>) -> HomeResponse)? = nil) {
        self.file = file
        hash = Restore.sha256(file)
        self.hold = hold
        self.otherwise = otherwise
    }

    var asked: [Range<Int64>] { lock.withLock { ranges } }
    var most: Int { lock.withLock { peak } }
    var paths: Set<String> { lock.withLock { asking } }

    func identify(_ address: URL, within: TimeInterval) async throws -> String {
        String(repeating: "A", count: 52)
    }

    func perform(_ request: HomeRequest) async throws -> HomeResponse {
        guard let words = request.headers["Range"], words.hasPrefix("bytes="),
              case let ends = words.dropFirst("bytes=".count).split(separator: "-"), ends.count == 2,
              let first = Int64(ends[0]), let last = Int64(ends[1]) else { return HomeResponse(status: 400, body: Data()) }
        let range = first..<last + 1
        let number = lock.withLock {
            ranges.append(range)
            asking.insert(request.url.path)
            flying += 1
            peak = max(peak, flying)
            return ranges.count - 1
        }
        defer { lock.withLock { flying -= 1 } }
        if number == hold {
            held.fulfill()
            let (cancelled, ended) = AsyncStream<Void>.makeStream()
            await withTaskCancellationHandler {
                for await _ in cancelled {}
            } onCancel: {
                ended.finish()
            }
            throw URLError(.cancelled)
        }
        if let (at, answer) = otherwise, at == number { return answer(range) }
        let total = Int64(file.count)
        guard first < total else {
            return HomeResponse(status: 416, headers: ["Content-Range": "bytes */\(total)"], body: Data())
        }
        let end = min(last, total - 1)
        return HomeResponse(status: 206, headers: ["Content-Range": "bytes \(first)-\(end)/\(total)"],
                            body: file[Int(first)...Int(end)])
    }
}

private final class Switches: @unchecked Sendable {
    private let lock = NSLock()
    private var told: [String] = []

    func flip(_ word: String) { lock.withLock { told.append(word) } }
    var said: [String] { lock.withLock { told } }
}

private final class Received: @unchecked Sendable {
    private let lock = NSLock()
    private var kept = Data()

    func add(_ piece: Data) -> Int {
        lock.withLock {
            kept += piece
            return kept.count
        }
    }

    var bytes: Data { lock.withLock { kept } }
}

private final class Doorway: URLProtocol, @unchecked Sendable {
    enum Answer { case whole, longer, halves, flood }

    static let file = Data((0..<5_000).map { UInt8($0 % 251) })
    static let flooded = Data((0..<(2 << 20)).map { UInt8($0 % 251) })
    static let hash = "sha256:" + String(repeating: "5d", count: 32)
    private static let lock = NSLock()
    nonisolated(unsafe) private static var answer = Answer.whole
    nonisolated(unsafe) private(set) static var stopped = XCTestExpectation(description: "the request cancelled")
    nonisolated(unsafe) private static var waiting: Doorway?

    static func reset(_ answer: Answer) {
        lock.withLock {
            self.answer = answer
            stopped = XCTestExpectation(description: "the request cancelled")
            waiting = nil
        }
    }

    static func rest() {
        guard let door = lock.withLock({ waiting }) else { return }
        door.client?.urlProtocol(door, didLoad: file[500..<1_000])
        door.client?.urlProtocolDidFinishLoading(door)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let answer = Self.lock.withLock { Self.answer }
        let (status, headers): (Int, [String: String]) = switch answer {
        case .whole: (200, ["Content-Type": "application/octet-stream"])
        case .longer, .halves: (206, ["Content-Type": "application/octet-stream", "Content-Range": "bytes 0-999/5000"])
        case .flood: (206, ["Content-Type": "application/octet-stream", "Content-Range": "bytes 0-262143/8388608"])
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!,
                            cacheStoragePolicy: .notAllowed)
        switch answer {
        case .whole:
            client?.urlProtocol(self, didLoad: Self.file.prefix(600))
        case .longer:
            client?.urlProtocol(self, didLoad: Self.file.prefix(600))
            client?.urlProtocol(self, didLoad: Self.file[600..<1_200])
        case .halves:
            Self.lock.withLock { Self.waiting = self }
            client?.urlProtocol(self, didLoad: Self.file.prefix(500))
        case .flood:
            for start in stride(from: 0, to: Self.flooded.count, by: 64 << 10) {
                client?.urlProtocol(self, didLoad: Self.flooded[start..<(start + (64 << 10))])
            }
        }
    }

    override func stopLoading() {
        Self.lock.withLock { Self.stopped }.fulfill()
    }
}
