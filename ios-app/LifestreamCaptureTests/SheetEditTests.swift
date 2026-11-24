import Cockpit
import HomeLink
import XCTest

@testable import Lifestream

@MainActor
final class SheetEditTests: XCTestCase {
    private struct Broke: LocalizedError {
        var errorDescription: String? { "The store is full." }
    }

    func testCheckIsLitOnlyWhileTheSheetHoldsSomethingElseThanItOpenedWith() {
        let acts = SheetActs()
        let opened = SheetEdit(opened: "Trips", now: "Trips") { .close }
        XCTAssertFalse(acts.canKeep(opened), "nothing changed as it opens")
        XCTAssertFalse(acts.holds(opened), "a swipe down drops nothing")
        let changed = SheetEdit(opened: "Trips", now: "Wedding") { .close }
        XCTAssertTrue(acts.canKeep(changed))
        XCTAssertTrue(acts.holds(changed), "a swipe down would drop the change")
        let restored = SheetEdit(opened: "Trips", now: "Trips") { .close }
        XCTAssertFalse(acts.canKeep(restored), "put back as it was, nothing to keep")
        XCTAssertFalse(acts.canKeep(SheetEdit(opened: "Trips", now: "", ready: false) { .close }), "changed, but not ready")

        XCTAssertTrue(acts.canKeep(SheetEdit(ready: true) { .close }), "something new: lit while ready")
        XCTAssertFalse(acts.canKeep(SheetEdit(ready: false) { .close }))
        XCTAssertFalse(acts.holds(SheetEdit(ready: true) { .close }), "something new holds no swipe of its own")
    }

    func testAKeepThatFailsStaysWithItsWordsAndTheNextTryDropsThem() async {
        let acts = SheetActs()
        let edit = SheetEdit(opened: "Trips", now: "Wedding") { .close }
        let notSent = await acts.run { throw SheetEdit.Failed(.notSent) }
        XCTAssertFalse(notSent)
        XCTAssertFalse(acts.closed, "the sheet stays as typed")
        XCTAssertEqual(acts.outcome, .failed(.notSent))
        XCTAssertTrue(acts.canKeep(edit), "✓ presses again")
        XCTAssertTrue(acts.canCancel)

        await acts.run { throw Broke() }
        XCTAssertEqual(acts.outcome, .failed(.refused("The store is full.")), "an error in its own words")

        await acts.run {
            XCTAssertNil(acts.outcome.failure, "running again drops the failure at once")
            return .stay
        }
        XCTAssertEqual(acts.outcome, .idle)
        XCTAssertFalse(acts.closed, "a keep that moves on leaves the sheet open")
    }

    func testAKeepThatLandsClosesTheSheetAndNothingRunsAfter() async {
        let acts = SheetActs()
        let edit = SheetEdit(opened: "Trips", now: "Wedding") { .close }
        let landed = await acts.run { .close }
        XCTAssertTrue(landed)
        XCTAssertTrue(acts.closed)
        XCTAssertEqual(acts.outcome, .idle)
        XCTAssertFalse(acts.canKeep(edit))
        XCTAssertFalse(acts.canCancel)
        let again = await acts.run("hide") {
            XCTFail("an act ran on a closed sheet")
            return .close
        }
        XCTAssertFalse(again)
    }

    func testWhileAKeepRunsNeitherCancelNorAnotherActPressesAndASwipeIsHeld() async {
        let acts = SheetActs()
        let edit = SheetEdit(ready: true) { .close }
        await acts.run {
            XCTAssertTrue(acts.running(SheetActs.keep))
            XCTAssertFalse(acts.running("hide"))
            XCTAssertFalse(acts.canCancel, "× is disabled while the keep runs")
            XCTAssertFalse(acts.canKeep(edit), "✓ presses once")
            XCTAssertTrue(acts.holds(edit), "a swipe down is held")
            let hide = await acts.run("hide") {
                XCTFail("a second act ran beside the keep")
                return .close
            }
            XCTAssertFalse(hide)
            return .close
        }
        XCTAssertTrue(acts.closed)
    }

    func testADayChosenIsSentAsItIsChosenUnlessTheHomeHoldsIt() {
        XCTAssertEqual(StreamDateRow.value(DateRow.Day(month: 3, day: 1, year: 2019), held: nil), "2019-03-01")
        XCTAssertEqual(StreamDateRow.value(DateRow.Day(month: 3, day: 1, year: 2019), held: "2018-12-31"), "2019-03-01")
        XCTAssertNil(StreamDateRow.value(DateRow.Day(month: 3, day: 1, year: 2019), held: "2019-03-01"), "the home's own day")
        XCTAssertNil(StreamDateRow.value(DateRow.Day(month: 3, day: 1), held: nil), "a day with no year is no day of a stream's")
        XCTAssertNil(StreamDateRow.value(nil, held: "2019-03-01"))
    }
}
