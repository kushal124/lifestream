import Foundation
import XCTest

@testable import LifestreamCaptureCore

final class StillWatchTests: XCTestCase {
    private let began: TimeInterval = 1_000
    private let late: TimeInterval = 1_100

    private func check(centreAccuracy: Double = 14) -> StillWatch.Check {
        .init(began: began, centreAccuracy: centreAccuracy)
    }

    private func fix(_ distance: Double, accuracy: Double = 5, at seconds: TimeInterval = 1) -> StillWatch.Fix {
        .init(madeAt: began + seconds, stated: began + seconds, distance: distance, accuracy: accuracy)
    }

    private func checking(centreAccuracy: Double = 14) -> StillWatch.Watch {
        var watch = StillWatch.Watch()
        watch.settled(at: began, centreAccuracy: centreAccuracy)
        XCTAssertEqual(watch.nextCheck, start)
        watch.beginCheck(at: start)
        return watch
    }

    private var start: TimeInterval { began + StillWatch.stillInterval }

    private func fix(_ distance: Double, accuracy: Double = 5, made: TimeInterval) -> StillWatch.Fix {
        .init(madeAt: made, stated: made, distance: distance, accuracy: accuracy)
    }

    func testNoFixOfAStillPhoneLeavesWhileNoMovementIsHeard() {
        var watch = check()
        let night: [(Double, Double)] = [(21, 6), (30, 11), (92, 44), (88, 28), (58, 17), (91, 17), (174, 49), (155, 42), (129, 43), (134, 59)]
        for (index, reading) in night.enumerated() {
            XCTAssertEqual(
                watch.read(fix(reading.0, accuracy: reading.1, at: Double(index) * 5), movementHeard: false, at: late), .still,
                "\(reading.0) m at ±\(reading.1) m")
        }
        XCTAssertFalse(watch.inDoubt)
    }

    func testOneFixFarAwayIsOnlyDoubt() {
        var watch = check()
        XCTAssertEqual(watch.read(fix(400), movementHeard: false, at: late), .doubt)
        XCTAssertTrue(watch.inDoubt)
        XCTAssertEqual(watch.read(fix(12, at: 2), movementHeard: false, at: late), .still, "the next fix is back: the first was a stray")
        XCTAssertFalse(watch.inDoubt)
    }

    func testAFixMadeBeforeTheCheckDecidesNothing() {
        var watch = check()
        XCTAssertEqual(watch.read(fix(3, at: -4.5), movementHeard: false, at: late), .nothing, "inside: it does not end the check")
        XCTAssertEqual(watch.read(fix(900, at: -4.5), movementHeard: true, at: late), .nothing, "outside: it does not begin a doubt")
        XCTAssertEqual(watch.read(fix(900, at: -0.2), movementHeard: true, at: late), .nothing)
        XCTAssertNil(watch.newestFresh)
        XCTAssertFalse(watch.inDoubt)
        XCTAssertEqual(watch.read(fix(3, at: 0), movementHeard: false, at: late), .still, "made as the check began: fresh")
        XCTAssertEqual(watch.newestFresh, began)
    }

    func testAFixOfInvalidAccuracyDecidesNothing() {
        var watch = check()
        XCTAssertEqual(watch.read(fix(900, accuracy: -1), movementHeard: true, at: late), .nothing)
        XCTAssertEqual(watch.read(fix(0, accuracy: -1), movementHeard: false, at: late), .nothing)
        XCTAssertNil(watch.newestFresh)
    }

    func testOnePositionStatedTwiceIsOneFix() {
        var watch = check()
        XCTAssertEqual(watch.read(fix(400, at: 1), movementHeard: false, at: late), .doubt)
        XCTAssertEqual(watch.read(fix(400, at: 1.4), movementHeard: false, at: late), .doubt)
        XCTAssertEqual(watch.read(fix(400, at: 3.9), movementHeard: false, at: late), .doubt, "under the gap still")
        XCTAssertEqual(watch.read(fix(405, at: 4), movementHeard: false, at: late), .left)
    }

    func testOneFixDeliveredAcrossAClockChangeIsOneFix() {
        var watch = check()
        XCTAssertEqual(watch.read(.init(madeAt: began + 1, stated: 500, distance: 400, accuracy: 5), movementHeard: false, at: late), .doubt)
        XCTAssertEqual(watch.read(.init(madeAt: began + 11, stated: 500, distance: 400, accuracy: 5), movementHeard: false, at: late), .doubt)
        XCTAssertEqual(watch.read(.init(madeAt: began + 12, stated: 503, distance: 405, accuracy: 5), movementHeard: false, at: late), .left)
    }

    func testAFixInsideClearsTheDoubt() {
        var watch = check()
        XCTAssertEqual(watch.read(fix(400, at: 1), movementHeard: false, at: late), .doubt)
        XCTAssertEqual(watch.read(fix(10, at: 2), movementHeard: false, at: late), .still)
        XCTAssertEqual(watch.read(fix(400, at: 20), movementHeard: false, at: late), .doubt, "a second stray begins again")
    }

    func testAWalkOutLeavesOnceMovementIsHeard() {
        var walking = check()
        XCTAssertEqual(walking.read(fix(60, accuracy: 10, at: 1), movementHeard: true, at: late), .doubt)
        XCTAssertEqual(walking.read(fix(66, accuracy: 10, at: 4), movementHeard: true, at: late), .left)
        var still = check()
        XCTAssertEqual(still.read(fix(60, accuracy: 10, at: 1), movementHeard: false, at: late), .still)
        XCTAssertEqual(still.read(fix(66, accuracy: 10, at: 4), movementHeard: false, at: late), .still)
    }

    func testADriveNoMotionNamedLeavesByDistanceAlone() {
        var watch = check()
        XCTAssertEqual(watch.read(fix(700, accuracy: 20, at: 1), movementHeard: false, at: late), .doubt)
        XCTAssertEqual(watch.read(fix(760, accuracy: 20, at: 4), movementHeard: false, at: late), .left)
    }

    func testTwoFixesOutsideConfirmInEitherOrderOfArrival() {
        var watch = check()
        XCTAssertEqual(watch.read(fix(400, at: 4), movementHeard: false, at: late), .doubt)
        XCTAssertEqual(watch.read(fix(400, at: 1), movementHeard: false, at: late), .left, "made 3 s before the one that came first")
        var close = check()
        XCTAssertEqual(close.read(fix(400, at: 4), movementHeard: false, at: late), .doubt)
        XCTAssertEqual(close.read(fix(400, at: 1.5), movementHeard: false, at: late), .doubt, "2.5 s apart, in either order")
        XCTAssertEqual(close.read(fix(400, at: 2), movementHeard: false, at: late), .doubt, "between the two: the span is theirs")
        XCTAssertEqual(close.read(fix(400, at: 1), movementHeard: false, at: late), .left)
    }

    func testOutsideIsTheWholeAccuracyCircle() {
        var watch = check()
        XCTAssertEqual(watch.read(fix(38, accuracy: 10, at: 1), movementHeard: true, at: late), .still, "38 − 10 = 28: touches")
        XCTAssertEqual(watch.read(fix(38.5, accuracy: 10, at: 2), movementHeard: true, at: late), .doubt)
        var far = check()
        XCTAssertEqual(far.read(fix(215, accuracy: 65, at: 1), movementHeard: false, at: late), .still, "215 − 65 = 150: touches")
        XCTAssertEqual(far.read(fix(216, accuracy: 65, at: 2), movementHeard: false, at: late), .doubt)
        var poor = check()
        XCTAssertEqual(poor.read(fix(115, accuracy: 40, at: 1), movementHeard: true, at: late), .still)
        XCTAssertEqual(poor.read(fix(125, accuracy: 40, at: 2), movementHeard: true, at: late), .doubt)
    }

    func testStillChecksSpaceOutAndStayUnderTheHomesSilence() {
        XCTAssertGreaterThanOrEqual(StillWatch.stillInterval, 120, "well beyond the 30 s it replaced")
        XCTAssertLessThan(StillWatch.stillInterval + StillWatch.lateTimers + StillWatch.checkTimeout, StillWatch.homeSilence)
        XCTAssertLessThanOrEqual(StillWatch.movingInterval, 30, "no slower than the checks it replaced")
        XCTAssertLessThanOrEqual(20 * 3_600 / StillWatch.stillInterval, 600)
    }

    func testAFixThatArrivesLateDoesNotPutTheNextCheckOff() {
        var watch = checking()
        XCTAssertEqual(watch.read(fix(10, made: start + 1), at: start + 25), .still)
        XCTAssertEqual(watch.nextCheck, start + 1 + StillWatch.stillInterval)
        XCTAssertNil(watch.checkEnds)

        let second = watch.nextCheck! + StillWatch.lateTimers
        watch.beginCheck(at: second)
        let last = watch.checkEnds!
        XCTAssertEqual(last, second + StillWatch.checkTimeout)
        XCTAssertLessThan(last - (start + 1), StillWatch.homeSilence, "the two fixes, as far apart as they can be made")
        XCTAssertEqual(watch.read(fix(10, made: last - 20), at: last), .still)
        XCTAssertEqual(watch.nextCheck, last - 20 + StillWatch.stillInterval)
    }

    func testTheNextCheckIsCountedFromTheNewestFreshFix() {
        var watch = checking()
        XCTAssertEqual(watch.read(fix(400, made: start + 9), at: start + 10), .doubt)
        XCTAssertEqual(watch.read(fix(10, made: start + 2), at: start + 11), .still)
        XCTAssertEqual(watch.nextCheck, start + 9 + StillWatch.stillInterval)
    }

    func testAFixStatedAfterNowSaysNothing() {
        var watch = checking()
        XCTAssertEqual(watch.read(fix(10, made: start + 500), at: start + 4), .nothing)
        XCTAssertEqual(watch.checkEnds, start + StillWatch.checkTimeout)
        XCTAssertNil(watch.nextCheck)
        XCTAssertFalse(watch.checkTimedOut(at: start + StillWatch.checkTimeout), "no fresh fix reached it")
        XCTAssertEqual(watch.nextCheck, start + StillWatch.stillInterval)

        var direct = check()
        XCTAssertEqual(direct.read(fix(10, at: 5), movementHeard: false, at: began + 4), .nothing)
        XCTAssertNil(direct.newestFresh)
        XCTAssertEqual(direct.read(fix(10, at: 4), movementHeard: false, at: began + 4), .still, "made now: fresh")
    }

    func testACheckNoFreshFixReachedSaysSoAndTheNextIsCountedFromItsStart() {
        var watch = checking()
        XCTAssertEqual(watch.read(fix(10, made: start - 40), at: start + 3), .nothing)
        XCTAssertEqual(watch.checkEnds, start + StillWatch.checkTimeout)
        XCTAssertFalse(watch.checkTimedOut(at: start + StillWatch.checkTimeout + 2))
        XCTAssertEqual(watch.nextCheck, start + StillWatch.stillInterval)
        XCTAssertLessThan(StillWatch.stillInterval + StillWatch.lateTimers, StillWatch.homeSilence)
        XCTAssertGreaterThan(StillWatch.stillInterval, 2 * StillWatch.checkTimeout)
    }

    func testACheckThatEndsInDoubtIsAnsweredSoon() {
        var watch = checking()
        XCTAssertEqual(watch.read(fix(400, made: start + 1), at: start + 1), .doubt)
        XCTAssertTrue(watch.checkTimedOut(at: start + 30), "a fix made since it began reached it")
        XCTAssertEqual(watch.nextCheck, start + 30 + StillWatch.movingInterval)
        watch.beginCheck(at: start + 60)
        XCTAssertEqual(watch.read(fix(10, made: start + 61), at: start + 61), .still)
        XCTAssertEqual(watch.nextCheck, start + 61 + StillWatch.stillInterval)
    }

    func testACheckBegunAgainEndsWhenItWasTo() {
        var watch = checking()
        XCTAssertEqual(watch.checkEnds, start + StillWatch.checkTimeout)
        watch.beginQuietCheck(at: start + 29, centreAccuracy: 40)
        watch.beginCheck(at: start + 29)
        XCTAssertEqual(watch.checkEnds, start + StillWatch.checkTimeout)
        XCTAssertNil(watch.quietEnds)
        XCTAssertEqual(watch.read(fix(400, made: start + 1), at: start + 29.5), .doubt, "and keeps what it read")
        XCTAssertEqual(watch.read(fix(400, made: start + 4), at: start + 29.6), .left)

        var asleep = StillWatch.Watch()
        asleep.settled(at: began, centreAccuracy: 14)
        asleep.beginQuietCheck(at: began + 1, centreAccuracy: 14)
        XCTAssertNil(asleep.checkEnds)
        XCTAssertEqual(asleep.nextCheck, start)
    }

    func testRecordingStatesItsQuietDeadline() {
        var watch = StillWatch.Watch()
        XCTAssertNil(watch.quietEnds, "before recording is told its quiet, no deadline")
        watch.recording(at: began, quiet: 120)
        XCTAssertEqual(watch.quietEnds, began + 120)
        XCTAssertNil(watch.nextCheck)
        XCTAssertNil(watch.checkEnds)
        watch.fixDelivered(at: began + 50, quiet: 120)
        XCTAssertEqual(watch.quietEnds, began + 170)
        watch.fixDelivered(at: began + 60, quiet: 300)
        XCTAssertEqual(watch.quietEnds, began + 360, "the quiet of the travel mode the fix came in")

        watch.recording(at: began + 70, quiet: nil)
        XCTAssertNil(watch.quietEnds)
        watch.fixDelivered(at: began + 80, quiet: 120)
        XCTAssertNil(watch.quietEnds, "degraded: a fix arms nothing")
        watch.recording(at: began + 90, quiet: 120)
        XCTAssertEqual(watch.quietEnds, began + 210, "leaving degraded mode arms one from now")

        watch.settled(at: began + 100, centreAccuracy: 14)
        watch.fixDelivered(at: began + 101, quiet: 120)
        XCTAssertNil(watch.quietEnds)
        XCTAssertEqual(watch.nextCheck, began + 100 + StillWatch.stillInterval)
    }

    func testAQuietCheckEndsAsACheckDoes() {
        let due = began + 120
        func quiet() -> StillWatch.Watch {
            var watch = StillWatch.Watch()
            watch.recording(at: began, quiet: 120)
            watch.beginQuietCheck(at: due, centreAccuracy: 14)
            return watch
        }

        var still = quiet()
        XCTAssertNil(still.quietEnds)
        XCTAssertEqual(still.checkEnds, due + StillWatch.checkTimeout)
        XCTAssertEqual(still.read(fix(10, made: due - 1), at: due + 1), .nothing, "the fix iOS kept from before")
        XCTAssertEqual(still.read(fix(10, made: due + 2), at: due + 2), .still)
        XCTAssertNil(still.checkEnds)
        XCTAssertEqual(still.nextCheck, due + 2 + StillWatch.stillInterval)

        var left = quiet()
        XCTAssertEqual(left.read(fix(400, made: due + 1), at: due + 1), .doubt)
        XCTAssertEqual(left.read(fix(400, made: due + 4), at: due + 4), .left)
        XCTAssertNil(left.checkEnds)
        XCTAssertNil(left.nextCheck)
        XCTAssertEqual(left.quietEnds, due + 4 + 120)

        var unanswered = quiet()
        XCTAssertFalse(unanswered.checkTimedOut(at: due + StillWatch.checkTimeout))
        XCTAssertNil(unanswered.quietEnds)
        XCTAssertEqual(unanswered.nextCheck, due + StillWatch.stillInterval)

        var short = StillWatch.Watch(checkTimeout: 0.5)
        short.recording(at: began, quiet: 1)
        short.beginQuietCheck(at: began + 1, centreAccuracy: 14)
        XCTAssertEqual(short.checkEnds, began + 1.5)
    }

    func testNoCheckBeginsBeforeThePhoneSettled() {
        var watch = StillWatch.Watch()
        watch.movementHeard(at: began)
        watch.regionExited(at: began + 1)
        XCTAssertNil(watch.nextCheck)
        watch.beginCheck(at: began + 2)
        XCTAssertNil(watch.checkEnds)
        XCTAssertEqual(watch.read(fix(900, made: began + 3), at: began + 3), .nothing)
        watch.settled(at: began + 10, centreAccuracy: 14)
        watch.beginCheck(at: began + 20)
        XCTAssertEqual(watch.read(fix(900, made: began + 21), at: began + 21), .doubt)
        XCTAssertEqual(watch.read(fix(900, made: began + 24), at: began + 24), .left)
        XCTAssertNil(watch.nextCheck)
        XCTAssertNil(watch.checkEnds)
        watch.beginCheck(at: began + 30)
        XCTAssertNil(watch.checkEnds)
    }

    func testMovementHeardDuringACheckCounts() {
        var watch = checking()
        XCTAssertEqual(watch.read(fix(60, accuracy: 10, made: start - 5), at: start + 1), .nothing)
        watch.movementHeard(at: start + 2)
        XCTAssertEqual(watch.checkEnds, start + StillWatch.checkTimeout, "the check is not begun again")
        XCTAssertEqual(watch.read(fix(60, accuracy: 10, made: start + 3), at: start + 3), .doubt)
        XCTAssertEqual(watch.read(fix(66, accuracy: 10, made: start + 6), at: start + 6), .left)
        var still = checking()
        XCTAssertEqual(still.read(fix(60, accuracy: 10, made: start + 3), at: start + 3), .still)
    }

    func testAnExitDuringACheckCounts() {
        var watch = checking()
        watch.regionExited(at: start + 2)
        XCTAssertEqual(watch.checkEnds, start + StillWatch.checkTimeout)
        XCTAssertEqual(watch.read(fix(60, accuracy: 10, made: start + 3), at: start + 3), .doubt)
        XCTAssertEqual(watch.read(fix(66, accuracy: 10, made: start + 6), at: start + 6), .left)
    }

    func testMovementThatBeginsIsCheckedAtOnce() {
        var watch = StillWatch.Watch()
        watch.settled(at: began, centreAccuracy: 14)
        watch.movementHeard(at: began + 40)
        XCTAssertEqual(watch.nextCheck, began + 40)
        var later = StillWatch.Watch()
        later.movementHeard(at: began - 60)
        later.settled(at: began, centreAccuracy: 14)
        XCTAssertEqual(later.nextCheck, began + StillWatch.stillInterval)
        later.movementHeard(at: began + 1)
        XCTAssertEqual(later.nextCheck, began + 1)
        var exit = StillWatch.Watch()
        exit.movementHeard(at: began - 5)
        exit.settled(at: began, centreAccuracy: 14)
        exit.regionExited(at: began + 1)
        XCTAssertEqual(exit.nextCheck, began + 1)
    }

    func testMovementThatGoesOnWaitsTheMovingInterval() {
        var watch = checking()
        watch.movementHeard(at: start + 1)
        XCTAssertEqual(watch.read(fix(10, made: start + 2), at: start + 2), .still)
        XCTAssertEqual(watch.nextCheck, start + 2 + StillWatch.movingInterval, "movement is heard: the next check is near")
        for second in stride(from: 3.0, through: 30, by: 3) {
            watch.movementHeard(at: start + second)
            XCTAssertEqual(watch.nextCheck, start + 2 + StillWatch.movingInterval)
        }
        watch.movementHeard(at: start + 40)
        XCTAssertEqual(watch.nextCheck, start + 2 + StillWatch.movingInterval)
    }

    func testMovementLastHeardAMinuteAgoIsNotHeard() {
        var watch = checking()
        watch.movementHeard(at: start - 59)
        XCTAssertEqual(watch.read(fix(10, made: start + 0.5), at: start + 0.5), .still)
        XCTAssertEqual(watch.nextCheck, start + 0.5 + StillWatch.movingInterval)
        watch.beginCheck(at: watch.nextCheck!)
        XCTAssertEqual(watch.read(fix(10, made: start + 31), at: start + 31), .still)
        XCTAssertEqual(watch.nextCheck, start + 31 + StillWatch.stillInterval)
        watch.movementHeard(at: start + 31 + StillWatch.stillInterval + 5)
        XCTAssertEqual(watch.nextCheck, start + 31 + StillWatch.stillInterval)
    }

    func testSettlingWhileMovementIsHeardChecksSoon() {
        var watch = StillWatch.Watch()
        watch.movementHeard(at: began - 10)
        watch.settled(at: began, centreAccuracy: 14)
        XCTAssertEqual(watch.nextCheck, began + StillWatch.movingInterval)
    }

    func testACentreOfInvalidAccuracyStillJudges() {
        var watch = check(centreAccuracy: -1)
        XCTAssertEqual(watch.read(fix(15, accuracy: 5, at: 1), movementHeard: true, at: late), .still)
        XCTAssertEqual(watch.read(fix(80, accuracy: 5, at: 2), movementHeard: true, at: late), .doubt)
        XCTAssertEqual(watch.read(fix(90, accuracy: 5, at: 5), movementHeard: true, at: late), .left)
    }

    func testClusterReach() {
        XCTAssertEqual(StillWatch.clusterReach(centreAccuracy: 3, fixAccuracy: 2), 20)
        XCTAssertEqual(StillWatch.clusterReach(centreAccuracy: 14, fixAccuracy: 30), 60)
        XCTAssertEqual(StillWatch.clusterReach(centreAccuracy: 14, fixAccuracy: 80), 100)
        XCTAssertNil(StillWatch.clusterReach(centreAccuracy: -1, fixAccuracy: 5))
        XCTAssertNil(StillWatch.clusterReach(centreAccuracy: 5, fixAccuracy: -1))
    }
}
