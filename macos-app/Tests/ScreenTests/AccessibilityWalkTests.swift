import ApplicationServices
import Evidence
import XCTest
@testable import Screen

final class AccessibilityWalkTests: XCTestCase {
    static let app: pid_t = 4242
    static let display = CaptureRect(x: 0, y: 0, width: 1440, height: 900)
    static let frame = CGRect(x: 100, y: 80, width: 900, height: 700)
    static let window = CaptureWindow(windowID: 103, title: "Synthetic window",
        application: CaptureApplication(bundleID: "com.example.editor", name: "Example Editor", pid: app),
        bounds: CaptureRect(x: 100, y: 80, width: 900, height: 700))

    func testEachElementCostsTwoCallsAndASecureFieldOnlyItsIdentity() async {
        let tree = FakeAccessibilityTree()
        let rows = (0..<40).map { tree.add(role: "AXRow", title: "row-\($0)") }
        let list = tree.add(role: "AXList", visibleChildren: [rows[3], rows[7]], children: rows)
        let hidden = tree.add(role: "AXButton", title: "never-read")
        let secure = tree.add(role: "AXTextField", subrole: "AXSecureTextField", value: "fake-secret", children: [hidden])
        let field = tree.add(role: "AXTextField", value: "field-value")
        let window = tree.add(role: "AXWindow", subrole: "AXStandardWindow", title: "Synthetic window",
                              frame: Self.frame, children: [list, secure, field], windowNumber: 103)
        tree.windows = [window]

        let snapshot = await AccessibilityReader.capture(pid: Self.app, windows: [Self.window], display: Self.display,
                                                         front: 103, calls: tree)

        XCTAssertEqual(snapshot.status, "complete-scoped-app-reported")
        XCTAssertEqual(snapshot.limitReasons, [])
        let order = [3, 7] + (0..<40).filter { $0 != 3 && $0 != 7 }
        XCTAssertEqual(snapshot.nodes.map { $0.title ?? $0.value ?? $0.role },
                       ["Synthetic window", "AXList"] + order.map { "row-\($0)" } + ["field-value"],
                       "visible children first, every child once, the secure field and its subtree absent")
        XCTAssertEqual(snapshot.nodes.map(\.depth), [0, 1] + Array(repeating: 2, count: 40) + [1])

        XCTAssertEqual(tree.calls(secure), [.identity], "a secure field is asked its role and subrole only")
        XCTAssertEqual(tree.calls(hidden), [])
        for element in rows + [list, field] {
            XCTAssertEqual(tree.calls(element), [.identity, .content], "two round trips, whatever the width")
        }
        XCTAssertEqual(tree.calls(tree.application), [.value(kAXWindowsAttribute)], "the window list in one call")
        XCTAssertEqual(tree.calls(window), [.batch([kAXPositionAttribute, kAXSizeAttribute, kAXRoleAttribute,
            kAXSubroleAttribute, kAXMainAttribute, kAXFocusedAttribute]), .windowNumber, .identity, .content,
            .batch([kAXPositionAttribute, kAXSizeAttribute])])
    }

    func testAFailedContentBatchStillReadsTheChildren() async {
        let tree = FakeAccessibilityTree()
        let button = tree.add(role: "AXButton", title: "button")
        let group = tree.add(role: "AXGroup", visibleChildren: [button], children: [button], contentFails: true)
        let window = tree.add(role: "AXWindow", subrole: "AXStandardWindow", title: "Synthetic window",
                              frame: Self.frame, children: [group], windowNumber: 103)
        tree.windows = [window]

        let snapshot = await AccessibilityReader.capture(pid: Self.app, windows: [Self.window], display: Self.display,
                                                         front: 103, calls: tree)

        XCTAssertEqual(snapshot.status, "partial-scoped-app-reported")
        XCTAssertEqual(snapshot.limitReasons, ["attribute-batch-incomplete", "ax-call-incomplete"])
        XCTAssertEqual(snapshot.nodes.map { $0.title ?? $0.role }, ["Synthetic window", "AXGroup", "button"])
        XCTAssertEqual(tree.calls(group), [.identity, .content, .value(kAXChildrenAttribute)])
    }
}

final class FakeAccessibilityTree: AccessibilityCalls, @unchecked Sendable {
    enum Call: Equatable {
        case identity, content
        case batch([String])
        case value(String)
        case windowNumber
    }
    struct Node {
        var role: String
        var subrole: String?
        var title: String?
        var value: String?
        var frame: CGRect?
        var visibleChildren: [AXUIElement] = []
        var children: [AXUIElement] = []
        var contentFails = false
        var windowNumber: UInt32?
    }

    private static let firstToken: pid_t = 7_000_000
    let application = AXUIElementCreateApplication(AccessibilityWalkTests.app)
    var windows: [AXUIElement] = []
    private var nodes: [pid_t: Node] = [:]
    private var log: [pid_t: [Call]] = [:]

    func add(role: String, subrole: String? = nil, title: String? = nil, value: String? = nil, frame: CGRect? = nil,
             visibleChildren: [AXUIElement] = [], children: [AXUIElement] = [], contentFails: Bool = false,
             windowNumber: UInt32? = nil) -> AXUIElement {
        let token = Self.firstToken + pid_t(nodes.count)
        nodes[token] = Node(role: role, subrole: subrole, title: title, value: value, frame: frame,
            visibleChildren: visibleChildren, children: children, contentFails: contentFails,
            windowNumber: windowNumber)
        return AXUIElementCreateApplication(token)
    }

    func calls(_ element: AXUIElement) -> [Call] { log[Self.token(element)] ?? [] }

    private static func token(_ element: AXUIElement) -> pid_t {
        var pid: pid_t = 0
        _ = AXUIElementGetPid(element, &pid)
        return pid
    }

    func trusted() -> Bool { true }
    func setTimeout(_ element: AXUIElement, _ seconds: Float) -> AXError { .success }
    func pid(_ element: AXUIElement) -> pid_t? { AccessibilityWalkTests.app }

    func values(_ element: AXUIElement, _ names: CFArray, _ result: inout CFArray?) -> AXError {
        let names = names as? [String] ?? []
        let token = Self.token(element)
        let call: Call = names == [kAXRoleAttribute, kAXSubroleAttribute] ? .identity
            : names.contains(kAXChildrenAttribute) ? .content : .batch(names)
        log[token, default: []].append(call)
        guard let node = nodes[token] else { return .invalidUIElement }
        if call == .content, node.contentFails { return .cannotComplete }
        result = names.map { slot(node, $0) } as CFArray
        return .success
    }

    func value(_ element: AXUIElement, _ name: String, _ result: inout CFTypeRef?) -> AXError {
        let token = Self.token(element)
        log[token, default: []].append(.value(name))
        if CFEqual(element, application) {
            result = windows as CFArray
            return .success
        }
        guard let node = nodes[token] else { return .invalidUIElement }
        result = slot(node, name)
        return .success
    }

    func windowNumber(_ element: AXUIElement) -> UInt32? {
        let token = Self.token(element)
        log[token, default: []].append(.windowNumber)
        return nodes[token]?.windowNumber
    }

    private func slot(_ node: Node, _ name: String) -> CFTypeRef {
        switch name {
        case kAXRoleAttribute: return node.role as CFString
        case kAXSubroleAttribute: return node.subrole.map { $0 as CFString } ?? kCFNull
        case kAXTitleAttribute: return node.title.map { $0 as CFString } ?? kCFNull
        case kAXValueAttribute: return node.value.map { $0 as CFString } ?? kCFNull
        case kAXPositionAttribute:
            guard var point = node.frame?.origin else { return kCFNull }
            return AXValueCreate(.cgPoint, &point)!
        case kAXSizeAttribute:
            guard var size = node.frame?.size else { return kCFNull }
            return AXValueCreate(.cgSize, &size)!
        case kAXVisibleChildrenAttribute: return node.visibleChildren as CFArray
        case kAXChildrenAttribute: return node.children as CFArray
        default: return kCFNull
        }
    }
}
