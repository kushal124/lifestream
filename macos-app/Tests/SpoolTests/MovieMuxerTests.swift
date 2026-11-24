import Foundation
import XCTest
import Evidence
@testable import Spool

final class MovieMuxerTests: XCTestCase {
    private final class Output: MovieOutput {
        enum Readiness {
            case never
            case now
            case queued
        }
        let readiness: Readiness
        let finishes: Bool
        private(set) var classes: [UInt32] = []
        private(set) var cancelled = false

        init(readiness: Readiness, finishes: Bool) {
            self.readiness = readiness
            self.finishes = finishes
        }

        func start() throws {}
        func onReady(queue: DispatchQueue, perform: @escaping () -> Void) {
            switch readiness {
            case .never: break
            case .now: queue.sync(execute: perform)
            case .queued: queue.async(execute: DispatchWorkItem(flags: .noQoS, block: perform))
            }
        }
        var isReady: Bool { true }
        func append(ordinal: Int) throws {
            classes.append(qos_class_self().rawValue)
        }
        func finish(_ completed: @escaping (Result<Void, Error>) -> Void) {
            if finishes { completed(.success(())) }
        }
        func cancel() {
            cancelled = true
        }
    }

    private final class Ended: @unchecked Sendable {
        var caller: UInt32 = 0
        var error: Error?
        let done = DispatchSemaphore(value: 0)
    }

    func testTheWriterRunsAtTheClassOfTheCallerItBlocks() throws {
        let output = Output(readiness: .queued, finishes: true)
        let ended = Ended()
        let caller = Thread {
            ended.caller = qos_class_self().rawValue
            do { try MovieMuxer.write(frameCount: 3, output: output) } catch { ended.error = error }
            ended.done.signal()
        }
        caller.qualityOfService = .userInitiated
        caller.start()
        XCTAssertEqual(ended.done.wait(timeout: .now() + 30), .success, "the write on a user-initiated thread ended")
        XCTAssertNil(ended.error)
        XCTAssertEqual(ended.caller, QOS_CLASS_USER_INITIATED.rawValue)
        XCTAssertEqual(output.classes, Array(repeating: QOS_CLASS_USER_INITIATED.rawValue, count: 3))
        XCTAssertFalse(output.cancelled)
    }

    func testATimeoutNamesTheStageTheWriterStalledIn() {
        let neverReady = Output(readiness: .never, finishes: true)
        XCTAssertThrowsError(try MovieMuxer.write(frameCount: 3, output: neverReady, timeout: 0)) {
            XCTAssertEqual($0 as? VideoArchiveError, .timeout(.appendFrame))
        }
        XCTAssertEqual(neverReady.classes.count, 0)
        XCTAssertTrue(neverReady.cancelled)

        let neverFinished = Output(readiness: .now, finishes: false)
        XCTAssertThrowsError(try MovieMuxer.write(frameCount: 3, output: neverFinished, timeout: 0)) {
            XCTAssertEqual($0 as? VideoArchiveError, .timeout(.finishWriting))
            XCTAssertEqual(($0 as NSError).localizedDescription,
                           "Could not finish movie writing within 15 seconds; retry with pending images intact")
        }
        XCTAssertEqual(neverFinished.classes.count, 3)
        XCTAssertTrue(neverFinished.cancelled)
    }
}
