import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

@MainActor
final class ReadThroughsTests: XCTestCase {
    private let rows: [HomeLink.SourceRead] = [
        .init(id: "example-log:local:test", readThroughMs: 1_940_688_000_000),
        .init(id: "example-chat:person-z@example.com:cloud", readThroughMs: 1_940_684_400_000),
        .init(id: "gmail:person-a@example.com:cloud", readThroughMs: nil),
    ]

    func testAnAnswerIsHeldAndASourceNeverReadIsLeftOut() async {
        let reads = ReadThroughs()
        XCTAssertNil(reads.held, "nothing before any answer")
        let moved = await reads.read { self.rows }
        XCTAssertTrue(moved)
        XCTAssertEqual(reads.held, ["example-log:local:test": 1_940_688_000_000, "example-chat:person-z@example.com:cloud": 1_940_684_400_000])
        let again = await reads.read { self.rows }
        XCTAssertFalse(again, "the same answer moves nothing")
    }

    func testAFailedReadKeepsTheLastGoodAnswerAndTheNextIsMade() async {
        let reads = ReadThroughs()
        _ = await reads.read { self.rows }
        let held = reads.held
        let failed = await reads.read { throw LinkFailure.noAnswer(sent: false) }
        XCTAssertFalse(failed)
        XCTAssertEqual(reads.held, held, "a failed read puts nothing")
        let later = await reads.read { [HomeLink.SourceRead(id: "example-log:local:test", readThroughMs: 1_940_689_800_000)] }
        XCTAssertTrue(later, "a failure leaves no read out")
        XCTAssertEqual(reads.held, ["example-log:local:test": 1_940_689_800_000])
    }

    func testOneReadIsOutAtATime() async {
        let reads = ReadThroughs()
        let (entered, enter) = AsyncStream<Void>.makeStream()
        let (answer, give) = AsyncStream<[HomeLink.SourceRead]>.makeStream()
        let first = Task { @MainActor in
            await reads.read {
                enter.yield()
                for await rows in answer { return rows }
                return []
            }
        }
        for await _ in entered { break }
        var asked = false
        let second = await reads.read {
            asked = true
            return []
        }
        XCTAssertFalse(second, "a read while one is out reads nothing")
        XCTAssertFalse(asked, "nor asks the home")
        give.yield(rows)
        let landed = await first.value
        XCTAssertTrue(landed)
        XCTAssertEqual(reads.held?.count, 2, "the read that was out lands")
    }
}
