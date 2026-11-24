import ApplicationServices
import Evidence
import Foundation
import XCTest
@testable import BrowserPages

final class PageReadingTests: XCTestCase {
    private let signal = PrivateWindowSignal.chromiumIncognito

    func testANormalWindowWithEightyControlsIsReadWithinItsDeadline() {
        let tree = FakeTree.chrome(controls: 80, url: "https://video.example/watch", cost: 0.001)
        var memo = NotPrivateWindows<Int>()
        let first = PageReading.read(FakeTree.window, signal: signal, memo: &memo, budget: 0.150,
                                     tree: { tree.withDeadline($0) }, now: tree.now)
        XCTAssertEqual(first.page, .site(Site(rule: "video.example:443")!))
        XCTAssertTrue(memo.contains(FakeTree.window), "one whole walk proved it not private")
    }

    func testAWalkCutShortProvesNothingAndAnIncognitoWindowIsNeverRemembered() {
        let slow = FakeTree.chrome(controls: 400, url: "https://news.example/", cost: 0.001)
        var memo = NotPrivateWindows<Int>()
        let read = PageReading.read(FakeTree.window, signal: signal, memo: &memo, budget: 0.150,
                                    tree: { slow.withDeadline($0) }, now: slow.now)
        XCTAssertEqual(read.page, .unknown)
        XCTAssertEqual(read.cause, .walkDeadline)
        XCTAssertFalse(memo.contains(FakeTree.window))
        XCTAssertEqual(slow.reads(of: FakeTree.window), 2, "tried once more, and no more")

        let incognito = FakeTree.chrome(controls: 20, url: "https://bank.example/", cost: 0.0001, incognito: true)
        var other = NotPrivateWindows<Int>()
        let secret = PageReading.read(FakeTree.window, signal: signal, memo: &other, budget: 0.150,
                                      tree: { incognito.withDeadline($0) }, now: incognito.now)
        XCTAssertEqual(secret.page, .privateWindow)
        XCTAssertFalse(other.contains(FakeTree.window))
    }

    func testARememberedWindowStopsAtThePageAndReadsFewerControls() {
        let tree = FakeTree.chrome(controls: 80, url: "https://video.example/watch", cost: 0.0001)
        var memo = NotPrivateWindows<Int>()
        _ = PageReading.read(FakeTree.window, signal: signal, memo: &memo, budget: 0.150,
                             tree: { tree.withDeadline($0) }, now: tree.now)
        let whole = tree.totalReads
        tree.resetCounts()
        tree.url = URL(string: "https://mail.example/inbox")
        let again = PageReading.read(FakeTree.window, signal: signal, memo: &memo, budget: 0.150,
                                     tree: { tree.withDeadline($0) }, now: tree.now)
        XCTAssertEqual(again.page, .site(Site(rule: "mail.example:443")!))
        XCTAssertLessThan(tree.totalReads, whole, "the remembered read stops at the page")
        XCTAssertEqual(tree.titleReads, 0, "and checks no control for the private button")
    }

    func testOneWindowsProofDoesNotCoverAnother() {
        let tree = FakeTree.chrome(controls: 10, url: "https://video.example/", cost: 0.0001)
        var memo = NotPrivateWindows<Int>()
        _ = PageReading.read(FakeTree.window, signal: signal, memo: &memo, budget: 0.150,
                             tree: { tree.withDeadline($0) }, now: tree.now)
        XCTAssertTrue(memo.contains(FakeTree.window))
        XCTAssertFalse(memo.contains(FakeTree.window + 1))
    }

    func testAPageWithNoAddressIsNotTriedAgain() {
        let tree = FakeTree.chrome(controls: 10, url: nil, cost: 0.0001)
        var memo = NotPrivateWindows<Int>()
        let read = PageReading.read(FakeTree.window, signal: signal, memo: &memo, budget: 0.150,
                                    tree: { tree.withDeadline($0) }, now: tree.now)
        XCTAssertEqual(read.page, .unknown)
        XCTAssertEqual(read.cause, .urlUnreadable)
        XCTAssertEqual(tree.reads(of: FakeTree.window), 2, "an address that did not read is tried once more")
        let blank = FakeTree.chrome(controls: 10, url: "about:blank", cost: 0.0001)
        let none = PageReading.read(FakeTree.window, signal: signal, memo: &memo, budget: 0.150,
                                    tree: { blank.withDeadline($0) }, now: blank.now)
        XCTAssertEqual(none.cause, .pageWithoutHost)
        XCTAssertEqual(blank.reads(of: FakeTree.window), 1, "a page with no host is what it is")
    }

    func testATitleThatDidNotReadIsAControlThatDidNotAnswer() throws {
        func failed(_ error: AXError) -> AnyObject {
            var error = error
            return AXValueCreate(.axError, &error)!
        }
        let role = "AXButton" as NSString, children = NSArray()
        XCTAssertNil(AccessibilityPageTree.node(from: [role, children, failed(.cannotComplete)], title: true),
                     "a title that failed may be the private button's")
        XCTAssertNil(AccessibilityPageTree.node(from: [role, children, failed(.failure)], title: true))
        XCTAssertNil(AccessibilityPageTree.node(from: [role, children, NSNumber(value: 1)], title: true),
                     "a title that is not text")
        let untitled = try XCTUnwrap(AccessibilityPageTree.node(from: [role, children, failed(.noValue)], title: true))
        XCTAssertNil(untitled.title, "a control with no title has none")
        XCTAssertNotNil(AccessibilityPageTree.node(from: [role, children, failed(.attributeUnsupported)], title: true))
        XCTAssertNotNil(AccessibilityPageTree.node(from: [role, children, kCFNull], title: true))
        let titled = try XCTUnwrap(AccessibilityPageTree.node(from: [role, children, "Incognito" as NSString], title: true))
        XCTAssertEqual(titled.title, "Incognito")
        XCTAssertNotNil(AccessibilityPageTree.node(from: [role, children], title: false))
    }

    func testAProofLeavesWithItsWindow() {
        var memo = NotPrivateWindows<Int>()
        memo.insert(1)
        memo.insert(2)
        memo.keep(only: [2, 3])
        XCTAssertFalse(memo.contains(1), "a window the browser no longer lists loses its proof")
        XCTAssertTrue(memo.contains(2))
        XCTAssertFalse(memo.contains(3), "listing proves nothing")
    }

    func testARetrySpendsWhatIsLeftOfTheBrowsersBudget() {
        let slow = FakeTree.chrome(controls: 1000, url: "https://news.example/", cost: 0.001)
        var memo = NotPrivateWindows<Int>()
        let limit = slow.now() + 0.200
        let first = PageReading.read(FakeTree.window, signal: signal, memo: &memo, budget: 0.150, until: limit,
                                     tree: { slow.withDeadline($0) }, now: slow.now)
        XCTAssertEqual(first.cause, .walkDeadline)
        XCTAssertLessThanOrEqual(slow.now(), limit + slow.cost, "the retry had only the 50 ms left, not 150 more")
        XCTAssertEqual(slow.reads(of: FakeTree.window), 2)
        slow.resetCounts()
        let second = PageReading.read(FakeTree.window, signal: signal, memo: &memo, budget: 0.150, until: limit,
                                      tree: { slow.withDeadline($0) }, now: slow.now)
        XCTAssertEqual(second.page, .unknown)
        XCTAssertEqual(second.cause, .walkDeadline)
        XCTAssertEqual(slow.totalReads, 0, "a window read after the budget is spent costs nothing")
    }

    func testTheDocumentDecidesThePageNeverTheFirstWebArea() {
        let tree = FakeTree.chrome(controls: 20, url: "https://bank.example/", cost: 0.0001, devTools: true)
        let document = URL(string: "https://bank.example/accounts")
        var memo = NotPrivateWindows<Int>()
        let read = PageReading.read(FakeTree.window, signal: signal, document: document, memo: &memo, budget: 0.150,
                                    tree: { tree.withDeadline($0) }, now: tree.now)
        XCTAssertEqual(read.page, .site(Site(rule: "bank.example:443")!), "the inspected page, never devtools")
        XCTAssertTrue(memo.contains(FakeTree.window))
        XCTAssertEqual(tree.urlReads, 0, "no web area's address is read")
    }

    func testADocumentIsBelievedOnlyAfterAWholeWalkProvedTheWindow() {
        let document = URL(string: "https://video.example/watch")
        let incognito = FakeTree.chrome(controls: 20, url: "https://video.example/", cost: 0.0001, incognito: true)
        var memo = NotPrivateWindows<Int>()
        let secret = PageReading.read(FakeTree.window, signal: signal, document: document, memo: &memo, budget: 0.150,
                                      tree: { incognito.withDeadline($0) }, now: incognito.now)
        XCTAssertEqual(secret.page, .privateWindow)
        XCTAssertFalse(memo.contains(FakeTree.window))

        let slow = FakeTree.chrome(controls: 400, url: "https://video.example/", cost: 0.001)
        let cut = PageReading.read(FakeTree.window, signal: signal, document: document, memo: &memo, budget: 0.150,
                                   tree: { slow.withDeadline($0) }, now: slow.now)
        XCTAssertEqual(cut.page, .unknown)
        XCTAssertEqual(cut.cause, .walkDeadline)
        XCTAssertFalse(memo.contains(FakeTree.window), "a walk cut short proves nothing, document or not")
    }

    func testAProvedWindowWithADocumentIsReadWithNoWalk() {
        let tree = FakeTree.chrome(controls: 80, url: nil, cost: 0.0001, webArea: false)
        var memo = NotPrivateWindows<Int>()
        let first = PageReading.read(FakeTree.window, signal: signal, document: URL(string: "https://video.example/"),
                                     memo: &memo, budget: 0.150, tree: { tree.withDeadline($0) }, now: tree.now)
        XCTAssertEqual(first.page, .site(Site(rule: "video.example:443")!))
        XCTAssertTrue(memo.contains(FakeTree.window), "the whole walk proved it, with or without a web area")
        tree.resetCounts()
        let again = PageReading.read(FakeTree.window, signal: signal, document: URL(string: "http://mail.example:8080/"),
                                     memo: &memo, budget: 0.150, tree: { tree.withDeadline($0) }, now: tree.now)
        XCTAssertEqual(again.page, .site(Site(rule: "mail.example:8080")!))
        XCTAssertEqual(tree.totalReads + tree.urlReads, 0, "a proved window costs no call past its own read")
        let blank = PageReading.read(FakeTree.window, signal: signal, document: URL(string: "about:blank"),
                                     memo: &memo, budget: 0.150, tree: { tree.withDeadline($0) }, now: tree.now)
        XCTAssertEqual(blank.page, .unknown)
        XCTAssertEqual(blank.cause, .pageWithoutHost)
    }

    func testAWindowsBatchReadFailsClosed() throws {
        func failed(_ error: AXError) -> AnyObject {
            var error = error
            return AXValueCreate(.axError, &error)!
        }
        var point = CGPoint(x: 10, y: 20), extent = CGSize(width: 800, height: 600)
        let position = AXValueCreate(.cgPoint, &point)!, size = AXValueCreate(.cgSize, &extent)!
        let standard = kAXStandardWindowSubrole as NSString, document = "https://video.example/watch" as NSString
        let read = AccessibilityPageTree.window(from: [standard, position, size, document], document: true)
        XCTAssertEqual(read, ShownWindow(kind: .standard, bounds: CaptureRect(x: 10, y: 20, width: 800, height: 600),
                                         document: URL(string: "https://video.example/watch")))
        XCTAssertEqual(AccessibilityPageTree.window(from: [failed(.cannotComplete), position, size, document],
                                                    document: true).kind, .unread, "it may be a private window")
        XCTAssertEqual(AccessibilityPageTree.window(from: [kCFNull, position, size], document: false).kind, .unread)
        XCTAssertEqual(AccessibilityPageTree.window(from: [failed(.attributeUnsupported), position, size],
                                                    document: false).kind, .other, "a window with no subrole shows no page")
        XCTAssertNil(AccessibilityPageTree.window(from: [standard, position, size, failed(.attributeUnsupported)],
                                                  document: true).document, "no document: the walk decides")
        XCTAssertNil(AccessibilityPageTree.window(from: [standard, failed(.cannotComplete), size],
                                                  document: false).bounds)
        XCTAssertEqual(AccessibilityPageTree.window(from: [standard, position, size], document: true).kind, .unread,
                       "a batch of the wrong length")
    }

    func testAWindowReadWithNoFrameStatesItsKindAndDocument() {
        func failed(_ error: AXError) -> AnyObject {
            var error = error
            return AXValueCreate(.axError, &error)!
        }
        let standard = kAXStandardWindowSubrole as NSString, document = "https://video.example/watch" as NSString
        XCTAssertEqual(AccessibilityPageTree.window(from: [standard, document], document: true, frame: false),
                       ShownWindow(kind: .standard, bounds: nil, document: URL(string: "https://video.example/watch")))
        XCTAssertEqual(AccessibilityPageTree.window(from: [failed(.cannotComplete), document], document: true,
                                                    frame: false).kind, .unread)
        XCTAssertEqual(AccessibilityPageTree.window(from: [standard], document: false, frame: false),
                       ShownWindow(kind: .standard, bounds: nil, document: nil))
        var point = CGPoint(x: 10, y: 20), extent = CGSize(width: 800, height: 600)
        let position = AXValueCreate(.cgPoint, &point)!, size = AXValueCreate(.cgSize, &extent)!
        XCTAssertEqual(AccessibilityPageTree.window(from: [standard, position, size, document], document: true,
                                                    frame: false).kind, .unread, "a batch of a frame's length")
    }

    func testTheMemoryIsBounded() {
        var memo = NotPrivateWindows<Int>(capacity: 3)
        for window in 0..<5 { memo.insert(window) }
        XCTAssertLessThanOrEqual(memo.count, 3)
    }
}

final class FakeTree: PageTree, @unchecked Sendable {
    static let window = 1
    private static let toolbar = 2
    private static let webArea = 3
    private static let devTools = 4
    private static let firstControl = 100

    var url: URL?
    let cost: Double
    private var clock = 0.0
    private var deadline = Double.infinity
    private var nodes: [Int: (role: String, title: String?, children: [Int])] = [:]
    private(set) var totalReads = 0
    private(set) var titleReads = 0
    private(set) var urlReads = 0
    private var urls: [Int: URL] = [:]
    private var readsByNode: [Int: Int] = [:]

    init(nodes: [Int: (role: String, title: String?, children: [Int])], url: URL?, cost: Double) {
        self.nodes = nodes
        self.url = url
        self.cost = cost
    }

    static func chrome(controls: Int, url: String?, cost: Double, incognito: Bool = false, devTools docked: Bool = false,
                       webArea shown: Bool = true) -> FakeTree {
        var nodes: [Int: (role: String, title: String?, children: [Int])] = [:]
        let buttons = (0..<controls).map { firstControl + $0 }
        nodes[window] = ("AXWindow", nil, [toolbar] + (docked ? [devTools] : []) + (shown ? [webArea] : []))
        nodes[toolbar] = ("AXToolbar", nil, buttons)
        for (index, id) in buttons.enumerated() {
            nodes[id] = ("AXButton", incognito && index == controls - 1 ? "Incognito" : "Synthetic", [])
        }
        nodes[webArea] = ("AXWebArea", nil, [])
        nodes[devTools] = ("AXWebArea", nil, [])
        let tree = FakeTree(nodes: nodes, url: url.flatMap(URL.init(string:)), cost: cost)
        tree.urls[devTools] = URL(string: "devtools://devtools/bundled/devtools_app.html")
        return tree
    }

    var now: () -> Double { { [unowned self] in clock } }

    func withDeadline(_ deadline: Double) -> FakeTree {
        self.deadline = deadline
        return self
    }

    func reads(of node: Int) -> Int { readsByNode[node] ?? 0 }

    func resetCounts() {
        totalReads = 0
        titleReads = 0
        urlReads = 0
        readsByNode = [:]
    }

    func read(_ node: Int, title: Bool) -> PageNode<Int>? {
        guard clock < deadline, let entry = nodes[node] else { return nil }
        clock += cost
        totalReads += 1
        if title { titleReads += 1 }
        readsByNode[node, default: 0] += 1
        return PageNode(role: entry.role, title: title ? entry.title : nil, children: entry.children)
    }

    func url(_ node: Int) -> URL? {
        guard clock < deadline else { return nil }
        clock += cost
        urlReads += 1
        return urls[node] ?? url
    }
}
