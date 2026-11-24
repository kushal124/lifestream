import ApplicationServices
import Evidence
import Foundation
import XCTest
@testable import BrowserPages

final class UnmatchedWindowTests: XCTestCase {
    private let bounds = CaptureRect(x: 0, y: 0, width: 1512, height: 982)
    private let modes = RecordingModes(siteActivity: ["chat.example"], siteExclude: ["bank.example"])
    private let chrome = "com.google.Chrome"

    private func window(_ page: BrowserPage?, standard: Bool = true) -> BrowserWindow {
        BrowserWindow(bounds: bounds, kind: standard ? .standard : .other, page: page)
    }

    private func site(_ host: String) -> BrowserPage { .site(Site(rule: host)!) }

    func testItTakesTheModeOfThePagesWhenEveryPageIsKnown() {
        XCTAssertEqual(UnmatchedBrowserWindow.mode(windows: [window(site("video.example")), window(nil, standard: false)],
                                                   app: chrome, modes: modes), .record)
        XCTAssertEqual(UnmatchedBrowserWindow.mode(windows: [window(site("video.example")), window(site("chat.example"))],
                                                   app: chrome, modes: modes), .activity, "the strictest page bounds it")
        XCTAssertEqual(UnmatchedBrowserWindow.mode(windows: [window(site("bank.example")), window(site("video.example"))],
                                                   app: chrome, modes: modes), .exclude)
    }

    func testAPrivateOrUnreadWindowLeavesItUnknown() {
        XCTAssertNil(UnmatchedBrowserWindow.mode(windows: [window(site("video.example")), window(.privateWindow)],
                                                 app: chrome, modes: modes))
        XCTAssertNil(UnmatchedBrowserWindow.mode(windows: [window(site("video.example")), window(.unknown)],
                                                 app: chrome, modes: modes))
        XCTAssertNil(UnmatchedBrowserWindow.mode(windows: [], app: chrome, modes: modes), "no window listed")
        XCTAssertNil(UnmatchedBrowserWindow.mode(windows: [window(nil, standard: false)], app: chrome, modes: modes),
                     "no page at all to bound it")
        XCTAssertNil(UnmatchedBrowserWindow.mode(windows: [window(site("video.example"))], app: chrome, modes: modes,
                                                 listComplete: false), "a list cut at its limit bounds nothing")
    }

    func testTheAppsOwnModeStillApplies() {
        var activityApp = modes
        try? activityApp.set(.activity, for: chrome)
        XCTAssertEqual(UnmatchedBrowserWindow.mode(windows: [window(site("video.example"))], app: chrome,
                                                   modes: activityApp), .activity)
    }

    func testAWindowWhoseKindDidNotReadBoundsNothing() {
        for unreadBounds in [nil, bounds] {
            let unread = BrowserWindow(bounds: unreadBounds, kind: .unread, page: nil, unknownCause: .windowUnreadable)
            XCTAssertNil(UnmatchedBrowserWindow.mode(windows: [window(site("video.example")), unread],
                                                     app: chrome, modes: modes),
                         "an unread window may be the private one the unmatched window shows")
        }
    }

    func testAWindowWhoseKindDidNotReadIsAnUnknownPageNotAWindowWithoutOne() {
        let unread = BrowserWindow(bounds: bounds, kind: .unread, page: nil)
        XCTAssertEqual(unread.shownPage, .unknown, "matched, it is an unknown page, never the app's mode")
        XCTAssertEqual(unread.unknownCause, .windowUnreadable)
        XCTAssertNil(window(nil, standard: false).shownPage, "a popup shows no page")
        XCTAssertEqual(window(site("video.example")).shownPage, site("video.example"))
        XCTAssertEqual(window(nil).shownPage, .unknown, "a standard window whose page is missing is unknown")
    }

    func testTheReadersKindIsUnreadWhenTheSubroleReadFailed() {
        XCTAssertEqual(BrowserWindowKind(subrole: "AXStandardWindow", error: .success), .standard)
        XCTAssertEqual(BrowserWindowKind(subrole: "AXDialog", error: .success), .other)
        XCTAssertEqual(BrowserWindowKind(subrole: nil, error: .noValue), .other)
        XCTAssertEqual(BrowserWindowKind(subrole: nil, error: .attributeUnsupported), .other)
        for error in [AXError.cannotComplete, .failure, .apiDisabled, .invalidUIElement, .notImplemented] {
            XCTAssertEqual(BrowserWindowKind(subrole: nil, error: error), .unread, "\(error.rawValue)")
        }
        XCTAssertEqual(BrowserWindowKind(subrole: nil, error: .success), .unread, "a subrole that is not text")
    }

    func testAMatchedWindowStandsInAsFrontOnlyWhenEveryWindowWasRead() {
        let read = [window(site("video.example")), window(nil, standard: false)]
        XCTAssertTrue(UnmatchedBrowserWindow.mayLookPast(windows: read, listComplete: true),
                      "full-screen strips with no twin are looked past while every window read")
        XCTAssertFalse(UnmatchedBrowserWindow.mayLookPast(
            windows: read + [BrowserWindow(bounds: nil, kind: .unread, page: nil)], listComplete: true))
        XCTAssertFalse(UnmatchedBrowserWindow.mayLookPast(
            windows: read + [BrowserWindow(bounds: bounds, kind: .unread, page: nil)], listComplete: true))
        XCTAssertFalse(UnmatchedBrowserWindow.mayLookPast(
            windows: read + [BrowserWindow(bounds: nil, kind: .standard, page: site("bank.example"))], listComplete: true),
                       "a page window whose frame did not read may be the unmatched one in front")
        XCTAssertFalse(UnmatchedBrowserWindow.mayLookPast(windows: read, listComplete: false))
        XCTAssertFalse(UnmatchedBrowserWindow.mayLookPast(windows: [], listComplete: true))
    }
}
