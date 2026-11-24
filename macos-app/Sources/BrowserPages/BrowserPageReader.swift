import ApplicationServices
import Evidence
import Foundation
import os

public enum BrowserWindowKind: Equatable, Sendable {
    case standard
    case other
    case unread

    init(subrole: String?, error: AXError) {
        switch error {
        case .success:
            guard let subrole else { self = .unread; return }
            self = subrole == kAXStandardWindowSubrole as String ? .standard : .other
        case .noValue, .attributeUnsupported:
            self = .other
        default:
            self = .unread
        }
    }
}

public struct BrowserWindow: Equatable, Sendable {
    public let bounds: CaptureRect?
    public let kind: BrowserWindowKind
    public let page: BrowserPage?
    public let unknownCause: PageUnknownCause?

    public init(bounds: CaptureRect?, kind: BrowserWindowKind, page: BrowserPage?,
                unknownCause: PageUnknownCause? = nil) {
        self.bounds = bounds
        self.kind = kind
        switch kind {
        case .standard: self.page = page
        case .other: self.page = nil
        case .unread: self.page = .unknown
        }
        let cause = kind == .unread ? unknownCause ?? .windowUnreadable : unknownCause
        self.unknownCause = self.page == .unknown ? cause : nil
    }

    public var shownPage: BrowserPage? {
        kind == .other ? nil : page ?? .unknown
    }
}

public final class BrowserPageReader: @unchecked Sendable {
    public static let shared = BrowserPageReader()
    public static let windowDeadline = 0.150
    public static let browserDeadline = 0.300
    public static let windowLimit = 64
    static let processLimit = 64

    private let windowDeadline: Double
    private let browserDeadline: Double
    private let enabled = OSAllocatedUnfairLock(initialState: Set<pid_t>())
    private let proved = OSAllocatedUnfairLock(initialState: [pid_t: NotPrivateWindows<AXUIElement>]())

    public init(windowDeadline: Double = BrowserPageReader.windowDeadline,
                browserDeadline: Double = BrowserPageReader.browserDeadline) {
        self.windowDeadline = windowDeadline
        self.browserDeadline = max(windowDeadline, browserDeadline)
    }

    public func windows(pid: pid_t, bundleID: String) -> [BrowserWindow] {
        ResourceMeter.shared.measure(.browserPages) { readWindows(pid: pid, bundleID: bundleID) }
    }

    private func readWindows(pid: pid_t, bundleID: String) -> [BrowserWindow] {
        guard let profile = Browsers.profile(bundleID) else { return [] }
        let limit = now() + browserDeadline
        let app = application(pid, profile)
        guard let windows = elements(app, kAXWindowsAttribute, deadline: min(now() + windowDeadline, limit)) else {
            return []
        }
        let listed = Set(windows)
        proved.withLock { $0[pid]?.keep(only: listed) }
        return windows.prefix(Self.windowLimit).map {
            window(of: $0, pid: pid, profile: profile, frame: true, until: limit)
        }
    }

    public func focusedWindow(pid: pid_t, bundleID: String) -> BrowserWindow? {
        ResourceMeter.shared.measure(.browserPages) { readFocusedWindow(pid: pid, bundleID: bundleID) }
    }

    private func readFocusedWindow(pid: pid_t, bundleID: String) -> BrowserWindow? {
        guard let profile = Browsers.profile(bundleID) else { return nil }
        let app = application(pid, profile)
        guard let focused = element(app, kAXFocusedWindowAttribute, deadline: now() + windowDeadline) else { return nil }
        return window(of: focused, pid: pid, profile: profile, frame: false, until: now() + browserDeadline)
    }

    public func window(containing element: AXUIElement, pid: pid_t, bundleID: String,
                       deadline: Double) -> BrowserWindow? {
        ResourceMeter.shared.measure(.browserPages) {
            readWindow(containing: element, pid: pid, bundleID: bundleID, deadline: deadline)
        }
    }

    private func readWindow(containing element: AXUIElement, pid: pid_t, bundleID: String,
                            deadline: Double) -> BrowserWindow? {
        guard let profile = Browsers.profile(bundleID) else { return nil }
        _ = application(pid, profile)
        guard let window = self.element(element, kAXWindowAttribute, deadline: deadline) else { return nil }
        return self.window(of: window, pid: pid, profile: profile, frame: false,
                           deadline: min(deadline, now() + windowDeadline))
    }


    private func window(of element: AXUIElement, pid: pid_t, profile: BrowserProfile, frame: Bool,
                        deadline stated: Double? = nil, until limit: Double? = nil) -> BrowserWindow {
        let tree = AccessibilityPageTree(deadline: min(stated ?? now() + windowDeadline, limit ?? .infinity))
        let shown = tree.window(element, frame: frame, document: profile.documentURL,
                                title: profile.privateSignal?.readsWindowTitle ?? false)
        guard shown.kind == .standard else { return BrowserWindow(bounds: shown.bounds, kind: shown.kind, page: nil) }
        guard profile.readsPages, let signal = profile.privateSignal else {
            return BrowserWindow(bounds: shown.bounds, kind: .standard, page: .unknown, unknownCause: .browserUnsupported)
        }
        var memo = proved.withLock { $0[pid] ?? NotPrivateWindows() }
        let read = PageReading.read(element, signal: signal, document: shown.document, title: shown.title, memo: &memo,
            budget: windowDeadline, deadline: stated, until: limit, tree: { AccessibilityPageTree(deadline: $0) }, now: now)
        if memo.contains(element) {
            proved.withLock { proved in
                if proved[pid] == nil, proved.count >= Self.processLimit { proved.removeAll() }
                proved[pid, default: NotPrivateWindows()].insert(element)
            }
        }
        return BrowserWindow(bounds: shown.bounds, kind: .standard, page: read.page, unknownCause: read.cause)
    }

    private func application(_ pid: pid_t, _ profile: BrowserProfile) -> AXUIElement {
        let app = AXUIElementCreateApplication(pid)
        guard profile.engine == .chromium else { return app }
        let first = enabled.withLock { enabled -> Bool in
            if enabled.count > 256 { enabled.removeAll() }
            return enabled.insert(pid).inserted
        }
        if first {
            AXUIElementSetMessagingTimeout(app, Float(windowDeadline))
            _ = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        }
        return app
    }

    private func element(_ parent: AXUIElement, _ attribute: String, deadline: Double) -> AXUIElement? {
        let left = deadline - now()
        guard left > 0, AXUIElementSetMessagingTimeout(parent, Float(left)) == .success else { return nil }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(parent, attribute as CFString, &value) == .success, let value,
              CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }

    private func elements(_ parent: AXUIElement, _ attribute: String, deadline: Double) -> [AXUIElement]? {
        AccessibilityPageTree(deadline: deadline).children(parent, attribute: attribute)
    }

    private func now() -> Double { ProcessInfo.processInfo.systemUptime }
}

struct ShownWindow: Equatable {
    let kind: BrowserWindowKind
    let bounds: CaptureRect?
    let document: URL?
    let title: String?

    init(kind: BrowserWindowKind, bounds: CaptureRect?, document: URL?, title: String? = nil) {
        self.kind = kind
        self.bounds = bounds
        self.document = document
        self.title = title
    }
}

struct AccessibilityPageTree: PageTree {
    let deadline: Double

    private func prepare(_ element: AXUIElement) -> Bool {
        let left = deadline - ProcessInfo.processInfo.systemUptime
        return left > 0 && AXUIElementSetMessagingTimeout(element, Float(left)) == .success
    }

    func window(_ window: AXUIElement, frame: Bool, document: Bool, title: Bool = false) -> ShownWindow {
        guard prepare(window) else { return ShownWindow(kind: .unread, bounds: nil, document: nil) }
        let names = ([kAXSubroleAttribute] + (frame ? [kAXPositionAttribute, kAXSizeAttribute] : [])
            + (title ? [kAXTitleAttribute] : []) + (document ? [kAXDocumentAttribute] : [])) as CFArray
        var values: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(window, names, AXCopyMultipleAttributeOptions(rawValue: 0),
                                                     &values) == .success,
              let list = values as? [AnyObject] else { return ShownWindow(kind: .unread, bounds: nil, document: nil) }
        return Self.window(from: list, document: document, frame: frame, title: title)
    }

    static func window(from list: [AnyObject], document: Bool, frame: Bool = true, title: Bool = false) -> ShownWindow {
        guard list.count == 1 + (frame ? 2 : 0) + (title ? 1 : 0) + (document ? 1 : 0) else {
            return ShownWindow(kind: .unread, bounds: nil, document: nil)
        }
        let kind = BrowserWindowKind(subrole: list[0] as? String, error: error(list[0]) ?? .success)
        var bounds: CaptureRect?
        var point = CGPoint.zero
        var extent = CGSize.zero
        if frame, let position = value(list[1]), let size = value(list[2]),
           AXValueGetValue(position, .cgPoint, &point), AXValueGetValue(size, .cgSize, &extent) {
            bounds = CaptureRect(x: point.x, y: point.y, width: extent.width, height: extent.height)
        }
        let named = title ? list[1 + (frame ? 2 : 0)] as? String : nil
        let stated = list[list.count - 1]
        let address = document ? (stated as? URL) ?? (stated as? String).flatMap(URL.init(string:)) : nil
        return ShownWindow(kind: kind, bounds: bounds, document: address, title: named)
    }

    private static func value(_ value: AnyObject) -> AXValue? {
        guard CFGetTypeID(value) == AXValueGetTypeID(), error(value) == nil else { return nil }
        return unsafeBitCast(value, to: AXValue.self)
    }

    func read(_ node: AXUIElement, title: Bool) -> PageNode<AXUIElement>? {
        guard prepare(node) else { return nil }
        let names = ([kAXRoleAttribute, kAXChildrenAttribute] + (title ? [kAXTitleAttribute] : [])) as CFArray
        var values: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(node, names, AXCopyMultipleAttributeOptions(rawValue: 0),
                                                     &values) == .success,
              let list = values as? [AnyObject] else { return nil }
        return Self.node(from: list, title: title)
    }

    static func node(from list: [AnyObject], title: Bool) -> PageNode<AXUIElement>? {
        guard list.count == (title ? 3 : 2) else { return nil }
        let role = list[0] as? String
        var name: String?
        if title {
            if let text = list[2] as? String {
                name = text
            } else if CFGetTypeID(list[2]) != CFNullGetTypeID() {
                guard let error = Self.error(list[2]), error == .noValue || error == .attributeUnsupported else { return nil }
            }
        }
        var children: [AXUIElement] = []
        if let items = list[1] as? [AnyObject] {
            children = items.compactMap { item in
                CFGetTypeID(item) == AXUIElementGetTypeID() ? unsafeBitCast(item, to: AXUIElement.self) : nil
            }
        } else if let error = Self.error(list[1]), error != .noValue, error != .attributeUnsupported {
            return nil
        }
        if role == nil, let error = Self.error(list[0]), error != .noValue, error != .attributeUnsupported {
            return nil
        }
        return PageNode(role: role, title: name, children: children)
    }

    private static func error(_ value: AnyObject) -> AXError? {
        guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        let wrapped = unsafeBitCast(value, to: AXValue.self)
        guard AXValueGetType(wrapped) == .axError else { return nil }
        var error = AXError.success
        guard AXValueGetValue(wrapped, .axError, &error) else { return nil }
        return error
    }

    func children(_ node: AXUIElement, attribute: String) -> [AXUIElement]? {
        guard prepare(node) else { return nil }
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(node, attribute as CFString, &value)
        if error == .noValue || error == .attributeUnsupported { return [] }
        guard error == .success, let list = value as? [AnyObject] else { return nil }
        return list.compactMap { item in
            CFGetTypeID(item) == AXUIElementGetTypeID() ? unsafeBitCast(item, to: AXUIElement.self) : nil
        }
    }

    func url(_ node: AXUIElement) -> URL? {
        guard prepare(node) else { return nil }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(node, "AXURL" as CFString, &value) == .success else { return nil }
        return (value as? URL) ?? (value as? String).flatMap(URL.init(string:))
    }
}
