import Foundation
import XCTest
@testable import Evidence

final class SecureInputRuleTests: XCTestCase {

    func testAStuckFlagWithNoPasswordFieldRecords() {
        XCTAssertNil(SecureInputRule.withheld(secureInput: true, field: { .none }))
    }

    func testAPasswordFieldFocusedOrInTheFrontWindowWithholdsAndSaysWhich() {
        XCTAssertEqual(SecureInputRule.withheld(secureInput: true, field: { .focused }), .secureFieldFocused)
        XCTAssertEqual(SecureInputRule.withheld(secureInput: true, field: { .inFrontWindow }), .secureFieldInFrontWindow)
    }

    func testAFrontThatCouldNotBeReadWithholdsAsSecureInput() {
        XCTAssertEqual(SecureInputRule.withheld(secureInput: true, field: { .unreadable }), .secureInputEnabled)
    }

    func testWithTheFlagOffTheFrontIsNotRead() {
        var reads = 0
        XCTAssertNil(SecureInputRule.withheld(secureInput: false, field: { reads += 1; return .focused }))
        XCTAssertEqual(reads, 0, "an ordinary capture pays no Accessibility read")
    }

    func testAToggledFlagIsJudgedAfreshAtEveryPhase() {
        let phases: [(flag: Bool, front: SecureFieldReading)] = [
            (true, .none), (false, .focused), (true, .focused),
        ]
        var reads = 0
        let answers = phases.map { phase in
            SecureInputRule.withheld(secureInput: phase.flag, field: { reads += 1; return phase.front })
        }
        XCTAssertEqual(answers, [nil, nil, .secureFieldFocused],
                       "a field focused by the last phase closes the attempt, though the first phase admitted it")
        XCTAssertEqual(reads, 2, "read once per phase with the flag on, and never with it off")
    }

    func testTheFrontIsReadOncePerAttemptWhateverThePhases() {
        var reads = 0
        let attempt = SecureFieldOnce { reads += 1; return .none }
        let answers = [true, false, true, true, true].map { flag in
            SecureInputRule.withheld(secureInput: flag, field: attempt.read)
        }
        XCTAssertEqual(answers, [nil, nil, nil, nil, nil])
        XCTAssertEqual(reads, 1, "every phase with the flag on shares one read")

        var unread = 0
        let off = SecureFieldOnce { unread += 1; return .focused }
        XCTAssertNil(SecureInputRule.withheld(secureInput: false, field: off.read))
        XCTAssertEqual(unread, 0, "with the flag off the front is never read")
        XCTAssertEqual(SecureInputRule.withheld(secureInput: true, field: off.read), .secureFieldFocused)
        XCTAssertEqual(unread, 1, "the first phase with the flag on reads it")
    }

    func testAReadTakenBeforeTheAttemptStandsForEveryPhase() {
        var reads = 0
        let attempt = SecureFieldOnce { reads += 1; return .none }
        attempt.seed(.inFrontWindow)
        XCTAssertEqual(SecureInputRule.withheld(secureInput: true, field: attempt.read), .secureFieldInFrontWindow)
        XCTAssertEqual(reads, 0, "the read taken off the main thread is the attempt's one read")
        attempt.seed(.none)
        XCTAssertEqual(SecureInputRule.withheld(secureInput: true, field: attempt.read), .secureFieldInFrontWindow,
                       "a later seed never replaces the attempt's read")
    }

    func testTheReasonsAreExpectedWaitsWithPinnedSpellings() {
        XCTAssertEqual(CaptureGapReason.secureFieldFocused.rawValue, "secure-field-focused")
        XCTAssertEqual(CaptureGapReason.secureFieldInFrontWindow.rawValue, "secure-field-in-front-window")
        XCTAssertEqual(CaptureGapReason.secureInputEnabled.rawValue, "secure-input-enabled")
        for reason in [CaptureGapReason.secureFieldFocused, .secureFieldInFrontWindow, .secureInputEnabled] {
            XCTAssertTrue(reason.isExpectedWait, reason.rawValue)
        }
    }

    func testTheGapStatesWhenAndWhy() {
        let at = Date(timeIntervalSince1970: 1_700_000_000.123)
        let gap = CaptureObservation.gap(at: at, reason: CaptureGapReason.secureFieldFocused.rawValue)
        XCTAssertEqual(gap.capturedAt, at)
        XCTAssertEqual(gap.reason, "secure-field-focused")
        XCTAssertEqual(gap.status, ObservationStatus.gap.rawValue)
    }


    func testATerminalWithAStuckFlagShowsNoPasswordField() {
        let tree = FakeFront.window(children: [
            .node(role: "AXGroup", children: [.node(role: "AXTextArea", id: "focus")]),
        ], focus: "focus")
        XCTAssertEqual(tree.search(), SecureFieldReading.none)
    }

    func testAFocusedPasswordFieldIsFoundByRoleOrSubrole() {
        let native = FakeFront.window(children: [.node(role: "AXSecureTextField", id: "focus")], focus: "focus")
        XCTAssertEqual(native.search(), .focused)
        let web = FakeFront.window(children: [
            .node(role: "AXTextField", subrole: "AXSecureTextField", id: "focus"),
        ], focus: "focus")
        XCTAssertEqual(web.search(), .focused)
    }

    func testAPasswordSheetOverTheWindowIsFoundThoughFocusIsOnItsButton() {
        let tree = FakeFront.window(children: [
            .node(role: "AXTextArea"),
            .node(role: "AXSheet", children: [
                .node(role: "AXTextField", subrole: "AXSecureTextField"),
                .node(role: "AXButton", id: "focus"),
            ]),
        ], focus: "focus")
        XCTAssertEqual(tree.search(), .inFrontWindow)
    }

    func testAPasswordFieldInABackgroundWindowDoesNotWithhold() {
        let tree = FakeFront.window(children: [.node(role: "AXTextArea", id: "focus")], focus: "focus",
            background: [.node(role: "AXSheet", children: [.node(role: "AXSecureTextField")])])
        XCTAssertEqual(tree.search(), SecureFieldReading.none)
        XCTAssertFalse(tree.wasRead("background"), "only the front window is walked")
    }

    func testNoFocusAndNoWindowIsNoPasswordField() {
        let tree = FakeFront(nodes: [:], focus: .absent, window: .absent)
        XCTAssertEqual(tree.search(), SecureFieldReading.none)
    }

    func testAFocusOrAWindowOrANodeThatDoesNotAnswerIsUnreadable() {
        XCTAssertEqual(FakeFront(nodes: [:], focus: .failed, window: .absent).search(), .unreadable)
        XCTAssertEqual(FakeFront(nodes: [:], focus: .absent, window: .failed).search(), .unreadable)
        var silent = FakeFront.window(children: [.node(role: "AXGroup", id: "mute")], focus: nil)
        silent.mute = ["mute"]
        XCTAssertEqual(silent.search(), .unreadable)
        var silentFocus = FakeFront.window(children: [.node(role: "AXTextArea", id: "focus")], focus: "focus")
        silentFocus.mute = ["focus"]
        XCTAssertEqual(silentFocus.search(), .unreadable, "a focused element whose role did not read may be a password field")
    }

    func testAWalkPastItsBudgetOrDeadlineIsUnreadable() {
        let wide = FakeFront.window(children: (0..<1500).map { _ in .node(role: "AXStaticText") }, focus: nil)
        XCTAssertEqual(wide.search(), .unreadable, "past the node budget")
        var slow = FakeFront.window(children: (0..<50).map { _ in .node(role: "AXStaticText") }, focus: nil)
        slow.cost = 0.005
        XCTAssertEqual(slow.search(deadline: 0.1), .unreadable, "past the deadline")
    }

    func testTheWalkNeverEntersAWebPage() {
        let tree = FakeFront.window(children: [
            .node(role: "AXWebArea", id: "page", children: (0..<3000).map { _ in .node(role: "AXStaticText") }
                + [.node(role: "AXTextField", subrole: "AXSecureTextField")]),
            .node(role: "AXTextField", id: "focus"),
        ], focus: "focus")
        XCTAssertEqual(tree.search(), SecureFieldReading.none)
        XCTAssertLessThan(tree.totalReads, 10)
    }
}

private struct FakeFront: SecureFieldTree {
    indirect enum Spec {
        case node(role: String, subrole: String? = nil, id: String? = nil, children: [Spec] = [])
    }

    typealias Node = Int

    struct Item {
        let role: String?
        let subrole: String?
        let children: [Int]
    }

    final class Clock {
        var time = 0.0
        var reads: [Int: Int] = [:]
    }

    var nodes: [Int: Item]
    var names: [String: Int] = [:]
    var focus: SecureFieldLookup<Int>
    var window: SecureFieldLookup<Int>
    var mute: Set<String> = []
    var cost = 0.00001
    let clock = Clock()

    init(nodes: [Int: Item], focus: SecureFieldLookup<Int>, window: SecureFieldLookup<Int>) {
        self.nodes = nodes
        self.focus = focus
        self.window = window
    }

    static func window(children: [Spec], focus: String?, background: [Spec] = []) -> FakeFront {
        var tree = FakeFront(nodes: [:], focus: .absent, window: .absent)
        let front = tree.add(.node(role: "AXWindow", id: "front", children: children))
        _ = tree.add(.node(role: "AXWindow", id: "background", children: background))
        tree.window = .found(front)
        if let focus, let id = tree.names[focus] { tree.focus = .found(id) }
        return tree
    }

    private mutating func add(_ spec: Spec) -> Int {
        guard case .node(let role, let subrole, let name, let children) = spec else { return -1 }
        let ids = children.map { add($0) }
        let id = nodes.count
        nodes[id] = Item(role: role, subrole: subrole, children: ids)
        if let name { names[name] = id }
        return id
    }

    func focusedElement() -> SecureFieldLookup<Int> { focus }
    func frontWindow() -> SecureFieldLookup<Int> { window }

    func read(_ node: Int) -> SecureFieldNode<Int>? {
        clock.time += cost
        clock.reads[node, default: 0] += 1
        guard let found = nodes[node], !mute.contains(where: { names[$0] == node }) else { return nil }
        return SecureFieldNode(role: found.role, subrole: found.subrole, children: found.children)
    }

    func search(deadline: Double = SecureFieldSearch<FakeFront>.deadline) -> SecureFieldReading {
        let clock = self.clock
        return SecureFieldSearch(tree: self, deadline: clock.time + deadline, now: { clock.time }).read()
    }

    func wasRead(_ name: String) -> Bool { names[name].map { clock.reads[$0] != nil } ?? false }
    var totalReads: Int { clock.reads.values.reduce(0, +) }
}
