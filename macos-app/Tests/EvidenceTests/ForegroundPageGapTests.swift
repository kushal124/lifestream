import Foundation
import XCTest
@testable import Evidence

final class ForegroundPageGapTests: XCTestCase {
    private let site = Site(rule: "bank.example")!

    func testEachPageGivesItsOwnReason() {
        XCTAssertEqual(ForegroundPageGap(page: .site(site), cause: nil).reason, .foregroundSiteRuleExcluded)
        XCTAssertEqual(ForegroundPageGap(page: .privateWindow, cause: nil).reason, .foregroundPrivateWindow)
        XCTAssertEqual(ForegroundPageGap(page: .unknown, cause: .walkDeadline).reason, .foregroundPageUnreadable)
        XCTAssertEqual(ForegroundPageGap(page: .unknown, cause: nil).reason, .foregroundPageUnreadable)
    }

    func testOnlyAnUnreadablePageStatesItsCause() {
        XCTAssertEqual(ForegroundPageGap(page: .unknown, cause: .noWebArea).cause, .noWebArea)
        XCTAssertNil(ForegroundPageGap(page: .unknown, cause: nil).cause)
        XCTAssertNil(ForegroundPageGap(page: .site(site), cause: .walkDeadline).cause)
        XCTAssertNil(ForegroundPageGap(page: .privateWindow, cause: .walkDeadline).cause)
    }

    func testTheGapObservationIsExcludedAndStatesTheCauseAndNoHost() {
        let date = Date(timeIntervalSince1970: 1_700_000_000.123)
        let unreadable = ForegroundPageGap(page: .unknown, cause: .noAccessibilityWindow).observation(at: date)
        XCTAssertEqual(unreadable.status, ObservationStatus.excluded.rawValue)
        XCTAssertEqual(unreadable.reason, "foreground-page-unreadable")
        XCTAssertEqual(unreadable.pageCause, "no-accessibility-window")
        XCTAssertNil(unreadable.site)
        let rule = ForegroundPageGap(page: .site(site), cause: nil).observation(at: date)
        XCTAssertEqual(rule.status, ObservationStatus.excluded.rawValue)
        XCTAssertEqual(rule.reason, "foreground-site-rule-excluded")
        XCTAssertNil(rule.pageCause)
        XCTAssertNil(rule.site, "an excluded site's host is never stated")
        let incognito = ForegroundPageGap(page: .privateWindow, cause: nil).observation(at: date)
        XCTAssertEqual(incognito.reason, "foreground-private-window")
        XCTAssertEqual(incognito.status, ObservationStatus.excluded.rawValue)
    }

    func testTheSpellingsArePinned() {
        XCTAssertEqual(CaptureGapReason.foregroundSiteRuleExcluded.rawValue, "foreground-site-rule-excluded")
        XCTAssertEqual(CaptureGapReason.foregroundPrivateWindow.rawValue, "foreground-private-window")
        XCTAssertEqual(CaptureGapReason.foregroundPageUnreadable.rawValue, "foreground-page-unreadable")
        XCTAssertEqual(PageUnknownCause.allCases.map(\.rawValue), [
            "browser-unsupported", "browser-did-not-answer", "no-accessibility-window",
            "ambiguous-accessibility-window", "walk-deadline", "walk-budget", "controls-unreadable",
            "no-web-area", "url-unreadable", "page-without-host", "window-unreadable",
        ])
    }

    func testThePageReasonsAreExpectedWaitsAndTheOldReasonIsGone() {
        for reason in [CaptureGapReason.foregroundSiteRuleExcluded, .foregroundPrivateWindow, .foregroundPageUnreadable] {
            XCTAssertTrue(reason.isExpectedWait, reason.rawValue)
        }
        XCTAssertNil(CaptureGapReason(rawValue: "foreground-site-excluded"),
                     "the ambiguous reason is historical only; the writer no longer produces it")
    }
}
