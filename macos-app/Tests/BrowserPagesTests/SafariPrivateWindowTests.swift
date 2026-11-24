import ApplicationServices
import Evidence
import Foundation
import XCTest
@testable import BrowserPages

final class SafariPrivateWindowTests: XCTestCase {
    private let safari = Browsers.profile("com.apple.Safari")!
    private let normalTitle = "Synthetic Page"

    func testSafariReadsPagesAndItsPrivateSignalIsTheWindowTitle() throws {
        XCTAssertTrue(safari.readsPages)
        XCTAssertEqual(safari.privateSignal, .windowTitleEnding(", Private Browsing"))
        XCTAssertTrue(try XCTUnwrap(safari.privateSignal).readsWindowTitle)
        XCTAssertFalse(Browsers.profile("com.apple.SafariTechnologyPreview")!.readsPages, "not measured")
        XCTAssertFalse(Browsers.profile("org.mozilla.firefox")!.readsPages)
        let chrome = try XCTUnwrap(Browsers.profile("com.google.Chrome")?.privateSignal)
        XCTAssertFalse(chrome.readsWindowTitle, "Chrome's batch asks for no title")
    }

    func testANormalSafariWindowStatesItsSiteAndIsProvedByItsTitle() {
        let tree = FakeTree.chrome(controls: 40, url: "https://video.example/watch", cost: 0.0001)
        var memo = NotPrivateWindows<Int>()
        let read = PageReading.read(FakeTree.window, signal: safari.privateSignal!, title: normalTitle, memo: &memo,
                                    budget: 0.150, tree: { tree.withDeadline($0) }, now: tree.now)
        XCTAssertEqual(read.page, .site(Site(rule: "video.example:443")!))
        XCTAssertNil(read.cause)
        XCTAssertEqual(tree.titleReads, 0, "no control's title is read: the signal is not among them")
        XCTAssertFalse(memo.contains(FakeTree.window), "a title proves one read, never the window's life")
    }

    func testAPrivateSafariWindowIsPrivateWhateverItsPageAndIsNotWalked() {
        let tree = FakeTree.chrome(controls: 40, url: "https://bank.example/", cost: 0.0001)
        var memo = NotPrivateWindows<Int>()
        for title in ["Synthetic Page, Private Browsing", ", Private Browsing", String(repeating: "a", count: 1000) + ", Private Browsing"] {
            let read = PageReading.read(FakeTree.window, signal: safari.privateSignal!, title: title, memo: &memo,
                                        budget: 0.150, tree: { tree.withDeadline($0) }, now: tree.now)
            XCTAssertEqual(read.page, .privateWindow)
            XCTAssertNil(read.cause)
        }
        XCTAssertEqual(tree.totalReads + tree.urlReads, 0, "nothing of a private window is read")
        XCTAssertFalse(memo.contains(FakeTree.window))
    }

    func testASafariWindowWhoseTitleDidNotReadIsUnknownEvenAfterAProof() {
        let tree = FakeTree.chrome(controls: 10, url: "https://video.example/", cost: 0.0001)
        var memo = NotPrivateWindows<Int>()
        _ = PageReading.read(FakeTree.window, signal: safari.privateSignal!, title: normalTitle, memo: &memo,
                             budget: 0.150, tree: { tree.withDeadline($0) }, now: tree.now)
        tree.resetCounts()
        let read = PageReading.read(FakeTree.window, signal: safari.privateSignal!, title: nil, memo: &memo,
                                    budget: 0.150, tree: { tree.withDeadline($0) }, now: tree.now)
        XCTAssertEqual(read.page, .unknown, "it may be a private window")
        XCTAssertEqual(read.cause, .windowUnreadable)
        XCTAssertEqual(tree.totalReads, 0)
    }

    func testAProvedSafariWindowStillFailsClosedWhenItsPageDoesNotRead() {
        let slow = FakeTree.chrome(controls: 10, url: "https://news.example/", cost: 0.200)
        var memo = NotPrivateWindows<Int>()
        let read = PageReading.read(FakeTree.window, signal: safari.privateSignal!, title: normalTitle, memo: &memo,
                                    budget: 0.150, tree: { slow.withDeadline($0) }, now: slow.now)
        XCTAssertEqual(read.page, .unknown)
        XCTAssertEqual(read.cause, .walkDeadline)
        XCTAssertEqual(slow.reads(of: FakeTree.window), 2, "tried once more, as any slow read")
        XCTAssertFalse(memo.contains(FakeTree.window), "proved by its title on this read only: its page is still not known")
    }

    func testAChromiumWindowIsJudgedByItsButtonNeverByATitle() {
        let incognito = FakeTree.chrome(controls: 20, url: "https://bank.example/", cost: 0.0001, incognito: true)
        var memo = NotPrivateWindows<Int>()
        let read = PageReading.read(FakeTree.window, signal: .chromiumIncognito, title: normalTitle, memo: &memo,
                                    budget: 0.150, tree: { incognito.withDeadline($0) }, now: incognito.now)
        XCTAssertEqual(read.page, .privateWindow)
        let normal = FakeTree.chrome(controls: 20, url: "https://video.example/", cost: 0.0001)
        let page = PageReading.read(FakeTree.window, signal: .chromiumIncognito, title: "x, Private Browsing",
                                    memo: &memo, budget: 0.150, tree: { normal.withDeadline($0) }, now: normal.now)
        XCTAssertEqual(page.page, .site(Site(rule: "video.example:443")!))
        XCTAssertTrue(memo.contains(FakeTree.window), "a whole walk still proves a Chromium window for its life")
    }

    func testTheWindowsBatchReadStatesItsTitleInItsOwnPlace() {
        func failed(_ error: AXError) -> AnyObject {
            var error = error
            return AXValueCreate(.axError, &error)!
        }
        var point = CGPoint(x: 10, y: 20), extent = CGSize(width: 800, height: 600)
        let position = AXValueCreate(.cgPoint, &point)!, size = AXValueCreate(.cgSize, &extent)!
        let standard = kAXStandardWindowSubrole as NSString, title = "Synthetic Page" as NSString
        let document = "https://video.example/watch" as NSString
        XCTAssertEqual(AccessibilityPageTree.window(from: [standard, position, size, title], document: false, title: true),
                       ShownWindow(kind: .standard, bounds: CaptureRect(x: 10, y: 20, width: 800, height: 600),
                                   document: nil, title: "Synthetic Page"))
        XCTAssertEqual(AccessibilityPageTree.window(from: [standard, title, document], document: true, frame: false,
                                                    title: true),
                       ShownWindow(kind: .standard, bounds: nil, document: URL(string: "https://video.example/watch"),
                                   title: "Synthetic Page"))
        XCTAssertNil(AccessibilityPageTree.window(from: [standard, failed(.cannotComplete)], document: false, frame: false,
                                                  title: true).title, "a title that failed is no title")
        XCTAssertNil(AccessibilityPageTree.window(from: [standard, NSNumber(value: 1)], document: false, frame: false,
                                                  title: true).title, "a title that is not text")
        XCTAssertNil(AccessibilityPageTree.window(from: [standard, position, size, title], document: false).title,
                     "a batch that asked for no title states none")
        XCTAssertEqual(AccessibilityPageTree.window(from: [standard, position, size], document: false, title: true).kind,
                       .unread, "a batch of the wrong length")
    }
}
