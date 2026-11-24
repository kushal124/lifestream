import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

final class HomeStartingTests: XCTestCase {
    private static let starting = "Your home is starting: it answers in a moment."
    private static let held = "The home is held: a check found damage."
    private static let checking = "Lifestream is checking its database."

    private var root: URL!
    private var clock: TestClock!
    private var home: FakeHome!
    private let credentials = MemoryCredentials()

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("home-starting-\(UUID().uuidString)")
        clock = TestClock(Date(timeIntervalSince1970: 1_791_000_000))
        let clock = self.clock!
        home = FakeHome(clock: { clock.now })
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func link() -> HomeLink {
        let clock = self.clock!
        return HomeLink(device: .init(kind: .phone, version: "1.0.0", model: "iPhone", serial4: nil), credentials: credentials,
                        folder: root.appendingPathComponent("exports"), transport: home, clock: { clock.now })
    }

    private static func seconds(_ duration: Duration) -> TimeInterval {
        TimeInterval(duration.components.seconds) + TimeInterval(duration.components.attoseconds) / 1e18
    }


    func testANotNowWaitsItsRetryAfterInTheDoorsWordsAndPairsAgainWithTheSameCodeAndPass() async throws {
        let link = link()
        home.answersPairsNotNow([("starting", Self.starting, "5"), ("needs", Self.checking, "60")])
        var heard: [HomeStarting.NotNow] = []
        var paused: [TimeInterval] = []
        try await HomeStarting.again(now: { self.clock.now }, pause: { duration in
            paused.append(Self.seconds(duration))
            self.clock.advance(Self.seconds(duration))
            return true
        }, heard: { heard.append($0) }) {
            _ = try await link.pair(code: FakeHome.code, name: "https://lifestream.example.ts.net", account: FakeHome.account)
        }
        XCTAssertEqual(heard.map(\.words), [Self.starting, Self.checking], "each wait in the door's words")
        XCTAssertEqual(heard.map(\.starting), [true, false], "a start by the door's kind")
        XCTAssertEqual(paused, [5, 60], "each wait its Retry-After")
        let asked = home.pairings
        XCTAssertEqual(asked.count, 3, "two not nows, then the pairing")
        XCTAssertEqual(Set(asked.map(\.code)), [FakeHome.code], "the same code each time")
        XCTAssertEqual(Set(asked.map(\.pass)).count, 1, "the same pass each time: one pairing, asked again")
        XCTAssertNotNil(try link.name(), "paired")
    }


    func testAHomeThatStaysStartingFailsAtTheBoundInTheDoorsNotNowNeverWaitingPastIt() async throws {
        let link = link()
        home.answersPairsNotNow(Array(repeating: ("starting", Self.starting, "50"), count: 10))
        var paused: [TimeInterval] = []
        do {
            try await HomeStarting.again(now: { self.clock.now }, pause: { duration in
                paused.append(Self.seconds(duration))
                self.clock.advance(Self.seconds(duration))
                return true
            }, heard: { _ in }) {
                _ = try await link.pair(code: FakeHome.code, name: "https://lifestream.example.ts.net")
            }
            XCTFail("a home that never served paired")
        } catch {
            XCTAssertEqual(HomeStarting.notNow(error), .init(words: Self.starting, retryAfter: 50, starting: true), "the last not now is the failure")
        }
        XCTAssertEqual(paused, [50, 50, 20], "the last wait cut at the bound")
        XCTAssertEqual(paused.reduce(0, +), HomeStarting.within)
        XCTAssertEqual(home.pairings.count, 3, "no ask at the bound or past it")
        XCTAssertNil(try link.name(), "not paired")
    }


    func testARequestHeldAcrossTheBoundIsCancelledThereAndTheNextPairingAsksWithItsPass() async throws {
        let link = link()
        home.answersPairsNotNow([("starting", Self.starting, "5")])
        let held = home.holdNextPair()
        let bounds = [HeldRequest(), HeldRequest()]
        let given = Count()
        let clock = self.clock!
        let waiting = Task { @MainActor in
            try await HomeStarting.again(now: { clock.now }, pause: { duration in
                clock.advance(Self.seconds(duration))
                return true
            }, bound: { _ in await bounds[given.next()].pass() }, heard: { _ in }) {
                _ = try await link.pair(code: FakeHome.code, name: "https://lifestream.example.ts.net")
            }
        }
        await held.arrived()
        bounds[1].open()
        do {
            try await waiting.value
            XCTFail("a pairing held past its bound paired")
        } catch {
            XCTAssertEqual(HomeStarting.notNow(error), .init(words: Self.starting, retryAfter: 5, starting: true), "the last not now is the failure")
        }
        XCTAssertEqual(home.pairingsCut, 1, "the request in flight was not cancelled at the bound")
        XCTAssertEqual(home.pairings.count, 2)
        XCTAssertNil(try link.name(), "an answer cut at the bound paired")
        try await HomeStarting.again(heard: { _ in }) {
            _ = try await link.pair(code: FakeHome.code, name: "https://lifestream.example.ts.net")
        }
        XCTAssertEqual(Set(home.pairings.map(\.pass)).count, 1, "the pairing cut was not kept: another pass asked")
        XCTAssertNotNil(try link.name(), "paired")
    }

    func testABoundReachedBeforeAnyNotNowIsNoAnswer() async throws {
        let held = home.holdNextPair()
        let bound = HeldRequest()
        let link = link()
        let waiting = Task { @MainActor in
            try await HomeStarting.again(bound: { _ in await bound.pass() }, heard: { _ in XCTFail("heard") }) {
                _ = try await link.pair(code: FakeHome.code, name: "https://lifestream.example.ts.net")
            }
        }
        await held.arrived()
        bound.open()
        do {
            try await waiting.value
            XCTFail("paired past the bound")
        } catch {
            XCTAssertEqual(error as? LinkFailure, .noAnswer(sent: true))
        }
        XCTAssertEqual(home.pairingsCut, 1)
    }


    func testTheBoundSaysAStartThatDidNotFinishOnlyForTheHomesStart() {
        let start = HomeStarting.NotNow(words: Self.starting, retryAfter: 5, starting: true)
        let held = HomeStarting.NotNow(words: Self.held, retryAfter: 60, starting: false)
        XCTAssertEqual(HomeStarting.said(start), "Lifestream didn't finish starting on your Mac. Try again in a moment.")
        XCTAssertEqual(HomeStarting.said(held), "Lifestream did not answer in time. \(Self.held)")
        XCTAssertEqual(HomeStarting.shown(start), "Lifestream is starting on your Mac: it answers in a moment.", "pairing speaks of the Mac")
        XCTAssertEqual(HomeStarting.shown(held), Self.held, "any other not now as given")
        XCTAssertEqual(HomeStarting.notNow(LinkFailure.unavailable(code: HomeStarting.code, message: Self.starting, retryAfter: nil, notNow: .busy))
                        .map(HomeStarting.said), "Lifestream did not answer in time. \(Self.starting)",
                       "the start's words under another kind are no start")
    }


    func testEveryOtherFailureIsThrownAtOnceAndOneAfterANotNowToo() async throws {
        let others: [LinkFailure] = [
            .unanswered(again: true, began: true),
            .unavailable(code: "HOME_FAILED", message: "Your home failed at it.", retryAfter: nil),
            .refused(status: 403, code: "PAIR_CODE", message: "wrong code"),
            .noAnswer(sent: true),
            .notTheHome,
        ]
        for other in others {
            let tries = Count()
            var paused = 0
            do {
                try await HomeStarting.again(pause: { _ in paused += 1; return true }, heard: { _ in XCTFail("\(other) heard as a start") }) {
                    _ = tries.next()
                    throw other
                }
                XCTFail("\(other) passed")
            } catch {
                XCTAssertEqual(error as? LinkFailure, other)
            }
            XCTAssertEqual(tries.value, 1, "\(other) asked again")
            XCTAssertEqual(paused, 0, "\(other) waited on")
        }
        let tries = Count()
        do {
            try await HomeStarting.again(pause: { _ in true }, heard: { _ in }) {
                if tries.next() == 0 { throw LinkFailure.unavailable(code: HomeStarting.code, message: Self.starting, retryAfter: 5) }
                throw LinkFailure.refused(status: 403, code: "PAIR_CODE", message: "wrong code")
            }
            XCTFail("a refused code passed")
        } catch LinkFailure.refused(_, "PAIR_CODE", _) {}
        XCTAssertEqual(tries.value, 2)
    }


    func testANotNowWithNoRetryAfterWaitsTheStartsWaitAndIsAStartByItsKindAlone() async throws {
        let link = link()
        home.answersPairsNotNow([("starting", "Your Mac is waking.", nil), ("needs", Self.starting, "soon")])
        var heard: [HomeStarting.NotNow] = []
        var paused: [TimeInterval] = []
        try await HomeStarting.again(now: { self.clock.now }, pause: { duration in
            paused.append(Self.seconds(duration))
            self.clock.advance(Self.seconds(duration))
            return true
        }, heard: { heard.append($0) }) {
            _ = try await link.pair(code: FakeHome.code, name: "https://lifestream.example.ts.net")
        }
        XCTAssertEqual(heard.map(\.starting), [true, false], "a start by the door's kind, whatever its words")
        XCTAssertEqual(paused, [HomeStarting.every, HomeStarting.every], "no Retry-After, or one not in seconds: the start's wait")
        XCTAssertEqual(home.pairings.count, 3)
    }


    func testAWaitThePersonLeftAsksNoMore() async throws {
        let link = link()
        home.answersPairsNotNow([("starting", Self.starting, "5")])
        do {
            try await HomeStarting.again(pause: { _ in false }, heard: { _ in }) {
                _ = try await link.pair(code: FakeHome.code, name: "https://lifestream.example.ts.net")
            }
            XCTFail("a wait left went on")
        } catch is CancellationError {}
        XCTAssertEqual(home.pairings.count, 1, "nothing asked after the person left")
        XCTAssertNil(try link.name())

        let held = home.holdNextPair()
        let waiting = Task { @MainActor in
            try await HomeStarting.again(heard: { _ in }) {
                _ = try await link.pair(code: FakeHome.code, name: "https://lifestream.example.ts.net")
            }
        }
        await held.arrived()
        waiting.cancel()
        do {
            try await waiting.value
            XCTFail("a wait left paired")
        } catch is CancellationError {}
        XCTAssertEqual(home.pairingsCut, 1, "the request in flight outlived the person leaving")
        XCTAssertNil(try link.name(), "a pairing left paired")
    }
}

private final class Count: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var value: Int { lock.withLock { count } }

    func next() -> Int {
        lock.withLock {
            defer { count += 1 }
            return count
        }
    }
}
