import Foundation
import ApplicationServices
import Evidence

struct AccessibilityPageScope: Sendable {
    let bundleID: String
    let modes: RecordingModes
}

enum AccessibilityReader {
    static let allowance = 0.25

    static func capture(pid: Int32, windows: [CaptureWindow], display: CaptureRect,
                        pages: AccessibilityPageScope? = nil, front: UInt32? = nil,
                        calls: any AccessibilityCalls = LiveAccessibilityCalls()) async -> AccessibilitySnapshot {
        await BlockingWork.run {
            ResourceMeter.shared.measure(.accessibility) {
                Reader(pid: pid, windows: windows, display: display, pages: pages, front: front, calls: calls).capture()
            }
        }
    }

    static let urlLimit = 2048
    static let webArea = "AXWebArea"

    static let identityBatch = AttributeBatch([.role, .subrole])
    private static let urlBatch = AttributeBatch([.url])
    private static let windowBatch = AttributeBatch([.position, .size, .role, .subrole, .main, .focused])
    private static let geometryBatch = AttributeBatch([.position, .size])
    private static let postflightBatch = AttributeBatch([.position, .size, .title])
    private static let contentBatch = AttributeBatch([.title, .description, .value, .position, .size,
                                                    .enabled, .visible, .focused, .selected, .expanded, .url,
                                                    .visibleChildren, .children])

    private struct Element: Hashable {
        let raw: AXUIElement
        static func == (lhs: Self, rhs: Self) -> Bool { CFEqual(lhs.raw, rhs.raw) }
        func hash(into hasher: inout Hasher) { hasher.combine(CFHash(raw)) }
    }

    private final class Reader {
        let pid: Int32
        let windows: [CaptureWindow]
        var target: CaptureWindow?
        let display: CaptureRect
        let started = Date()
        let deadline = ProcessInfo.processInfo.systemUptime + AccessibilityReader.allowance
        let pages: AccessibilityPageScope?
        let front: UInt32?
        let calls: any AccessibilityCalls
        var correlation = "unique-pid-and-window-geometry"
        var insidePage = Set<Element>()
        var pagesAdmitted = 0
        var pagesRefused = 0
        var plannedPageSeen = false
        var reasons = Set<AccessibilityLimitReason>()
        var callDeadline: Double?
        var candidateWindowBounds: [CaptureRect]?
        var candidateWindowCount: Int?
        var scopedMatchingWindowCount: Int?
        var children: [Element: [Element]] = [:]
        init(pid: Int32, windows: [CaptureWindow], display: CaptureRect, pages: AccessibilityPageScope?,
             front: UInt32?, calls: any AccessibilityCalls) {
            self.pid = pid
            self.windows = windows
            self.display = display
            self.pages = pages
            self.front = front
            self.calls = calls
        }
        var remaining: Double { (callDeadline ?? deadline) - ProcessInfo.processInfo.systemUptime }
        func prepare(_ element: AXUIElement) -> Bool {
            guard remaining > 0 else {
                reasons.insert(.walkDeadline)
                return false
            }
            guard calls.setTimeout(element, Float(min(0.025, remaining))) == .success else {
                reasons.insert(.messagingTimeoutUnavailable)
                return false
            }
            return true
        }
        func failure(_ error: AXError) {
            if error != .success && error != .attributeUnsupported && error != .noValue {
                reasons.insert(error == .cannotComplete ? .axCallIncomplete : .nativeCallError(error.rawValue))
            }
        }
        func attributes(_ element: AXUIElement, _ batch: AttributeBatch,
                        incompleteReason: AccessibilityLimitReason = .attributeBatchIncomplete) -> AttributeValues? {
            guard prepare(element) else { return nil }
            var array: CFArray?
            let error = calls.values(element, batch.names, &array)
            guard error == .success, let array, let values = batch.decode(array) else {
                failure(error)
                reasons.insert(incompleteReason)
                return nil
            }
            for field in batch.fields {
                switch values.slot(field) {
                case .failed(let error): failure(error)
                case .unreadableError: reasons.insert(.attributeErrorUnreadable)
                default: break
                }
            }
            return values
        }
        func identity(_ element: AXUIElement) -> AccessibilityElementIdentity? {
            guard let values = attributes(element, AccessibilityReader.identityBatch,
                                          incompleteReason: .identityBatchIncomplete) else { return nil }
            let role = values.identity(.role), subrole = values.identity(.subrole)
            if role == .failed || subrole == .failed { reasons.insert(.identityAttributeUnverified) }
            return AccessibilityElementIdentity.permittingContent(role: role, subrole: subrole)
        }
        func bounds(_ details: AttributeValues) -> CaptureRect? {
            guard let p = details[.position] as CFTypeRef?, let s = details[.size] as CFTypeRef?,
                  CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
            var point = CGPoint.zero
            var size = CGSize.zero
            guard AXValueGetValue(unsafeBitCast(p, to: AXValue.self), .cgPoint, &point),
                  AXValueGetValue(unsafeBitCast(s, to: AXValue.self), .cgSize, &size),
                  point.x.isFinite, point.y.isFinite, size.width.isFinite, size.height.isFinite else { return nil }
            return CaptureRect(x: point.x, y: point.y, width: size.width, height: size.height)
        }
        func array(_ element: AXUIElement, _ name: String) -> [Any]? {
            guard prepare(element) else { return nil }
            var value: CFTypeRef?
            let error = calls.value(element, name, &value)
            failure(error)
            return error == .success ? value as? [Any] : nil
        }
        static func elements(_ value: Any?) -> [Element] {
            guard let values = value as? [Any] else { return [] }
            return values.compactMap { value in
                let reference = value as CFTypeRef
                guard CFGetTypeID(reference) == AXUIElementGetTypeID() else { return nil }
                return Element(raw: unsafeBitCast(reference, to: AXUIElement.self))
            }
        }
        func snapshot(_ status: AccessibilityStatus, nodes: [AccessibilityNode] = [], correlated: Bool = false,
                      visited: Int? = nil) -> AccessibilitySnapshot {
            var result = AccessibilitySnapshot(capturedAt: started, status: status.rawValue, nodes: nodes,
                capturedUntil: Date())
            result.targetWindowID = target?.windowID
            result.targetWindowBounds = target?.bounds
            result.windowCorrelation = correlated ? correlation : "unavailable"
            result.limitReasons = reasons.map(\.rawValue).sorted()
            result.visitedElements = visited
            result.candidateWindowBounds = candidateWindowBounds
            result.candidateWindowCount = candidateWindowCount
            result.scopedMatchingWindowCount = scopedMatchingWindowCount
            return result
        }
        func capture() -> AccessibilitySnapshot {
            guard calls.trusted() else { return snapshot(.permissionDenied) }
            let hasTarget = windows.contains {
                $0.application?.pid == pid && AccessibilityWindowCorrelation.intersects($0.bounds, display)
            }
            guard hasTarget else { return snapshot(.targetWindowUnavailable) }
            let app = AXUIElementCreateApplication(pid)
            let listed = array(app, kAXWindowsAttribute)
            let total = listed?.count ?? 0
            candidateWindowCount = total
            guard total <= 64 else {
                reasons.insert(.windowListBudget)
                return snapshot(.windowCorrelationUnavailable)
            }
            let axWindows = Self.elements(listed)
            guard axWindows.count == total, total > 0 else { return snapshot(.windowCorrelationUnavailable) }
            let candidates = axWindows.map { element -> AccessibilityWindowCandidate in
                guard calls.pid(element.raw) == pid else { return AccessibilityWindowCandidate(bounds: nil) }
                let details = attributes(element.raw, AccessibilityReader.windowBatch)
                let number = front != nil && prepare(element.raw) ? calls.windowNumber(element.raw) : nil
                return AccessibilityWindowCandidate(bounds: details.flatMap(bounds), role: details?[.role] as? String,
                    subrole: details?[.subrole] as? String,
                    main: (details?[.main] as? NSNumber)?.boolValue,
                    focused: (details?[.focused] as? NSNumber)?.boolValue, windowID: number)
            }
            candidateWindowBounds = candidates.compactMap(\.bounds)
            let resolution = AccessibilityWindowCorrelation.resolve(windows: windows, pid: pid,
                display: display, candidates: candidates, front: front)
            if case .identified = resolution {
                correlation = "exact-window-id"
            } else if !candidates.allSatisfy({ $0.bounds != nil }) {
                reasons.insert(.candidateWindowGeometryUnavailable)
                return snapshot(.windowCorrelationUnavailable)
            }
            let root: Element
            switch resolution {
            case .identified(let windowIndex, let accessibilityIndex):
                target = windows[windowIndex]
                root = axWindows[accessibilityIndex]
            case .unavailable:
                scopedMatchingWindowCount = 0
                reasons.insert(.windowGeometryNoMatch)
                return snapshot(.windowCorrelationMismatchOrAmbiguous)
            case .ambiguous(let windowIndex):
                target = windows[windowIndex]
                scopedMatchingWindowCount = candidateWindowBounds?.filter {
                    AccessibilityWindowCorrelation.matches($0, windows[windowIndex].bounds) &&
                    AccessibilityWindowCorrelation.intersects($0, display)
                }.count
                reasons.insert(.windowGeometryAmbiguous)
                return snapshot(.windowCorrelationMismatchOrAmbiguous)
            case .matched(let windowIndex, let accessibilityIndex):
                target = windows[windowIndex]
                root = axWindows[accessibilityIndex]
            }
            guard let target else { return snapshot(.targetWindowUnavailable) }
            candidateWindowBounds = nil
            candidateWindowCount = nil
            scopedMatchingWindowCount = nil
            var budget = AccessibilityTraversalBudget()
            callDeadline = deadline - 0.030
            budget.maximumSeconds = max(0, remaining)
            let walked = AccessibilityTraversal.walk(root: root, budget: budget,
                now: { ProcessInfo.processInfo.systemUptime }, read: read)
            reasons.formUnion(walked.reasons)
            callDeadline = nil
            let postflight = attributes(root.raw, pages == nil ? AccessibilityReader.geometryBatch
                                                                : AccessibilityReader.postflightBatch)
            guard let final = postflight.flatMap(bounds),
                  AccessibilityWindowCorrelation.matches(final, target.bounds),
                  AccessibilityWindowCorrelation.intersects(final, display) else {
                reasons.insert(.windowPostflightUnverified)
                return snapshot(.windowChangedOrUnverifiable, visited: walked.visited)
            }
            if pages != nil, let refusal = pageRefusal(tree: walked.nodes, target: target,
                                                        finalTitle: postflight?[.title] as? String) {
                reasons.insert(refusal)
                var dropped = snapshot(.windowChangedDuringCapture, visited: walked.visited)
                dropped.windowCorrelation = "changed-during-capture"
                return dropped
            }
            return snapshot(reasons.isEmpty ? .completeScopedAppReported : .partialScopedAppReported,
                            nodes: walked.nodes, correlated: true, visited: walked.visited)
        }
        func pageRefusal(tree: [AccessibilityNode], target: CaptureWindow, finalTitle: String?) -> AccessibilityLimitReason? {
            if pagesRefused > 0 { return .pageNotRecorded }
            if pagesAdmitted > 0, target.site != nil, !plannedPageSeen { return .pageChangedDuringWalk }
            if let root = tree.first, root.depth == 0, root.title != finalTitle { return .pageChangedDuringWalk }
            return nil
        }
        func admitsPage(_ element: AXUIElement) -> Bool {
            guard let pages else { return true }
            let url = attributes(element, AccessibilityReader.urlBatch)?[.url].flatMap(Self.url)
            let site = url.flatMap(URL.init(string:)).flatMap(Site.init(page:))
            let page = site.map(BrowserPage.site) ?? .unknown
            guard pages.modes.mode(app: pages.bundleID, page: page) == .record else { return false }
            if let site, site.host == target?.site { plannedPageSeen = true }
            return true
        }
        static func url(_ value: CFTypeRef) -> String? {
            let spelled = (value as? URL)?.absoluteString ?? (value as? String)
            return spelled.flatMap { $0.isEmpty ? nil : String($0.prefix(AccessibilityReader.urlLimit)) }
        }
        func read(_ element: Element, depth: Int, offset: Int, pageSize: Int) -> AccessibilityTraversalRead<Element> {
            var node: AccessibilityNode?
            if offset == 0 {
                guard let identity = identity(element.raw) else { return AccessibilityTraversalRead(node: nil) }
                let role = identity.role
                let subrole = identity.subrole
                if pages != nil, role == AccessibilityReader.webArea, !insidePage.contains(element) {
                    guard admitsPage(element.raw) else {
                        pagesRefused += 1
                        callDeadline = ProcessInfo.processInfo.systemUptime
                        return AccessibilityTraversalRead(node: nil)
                    }
                    pagesAdmitted += 1
                    insidePage.insert(element)
                }
                let details = attributes(element.raw, AccessibilityReader.contentBatch)
                let title = details?[.title] as? String
                let description = details?[.description] as? String
                let value = (details?[.value] as? String) ?? (details?[.value] as? NSNumber)?.stringValue
                let fields = [title, description, value].compactMap { $0 }.filter { !$0.isEmpty }
                func flag(_ name: Attribute) -> Bool? { (details?[name] as? NSNumber).map { $0.boolValue } }
                let rawCheck = details?[.value] as? NSNumber
                let checked: Bool? = [kAXCheckBoxRole as String, kAXRadioButtonRole as String].contains(role) &&
                    (rawCheck == 0 || rawCheck == 1) ? rawCheck?.boolValue : nil
                node = AccessibilityNode(role: role, text: fields.isEmpty ? nil : fields.joined(separator: "\n"),
                    bounds: details.flatMap(bounds), depth: depth, subrole: subrole, title: title,
                    description: description, value: value,
                    enabled: flag(.enabled), visible: flag(.visible), focused: flag(.focused),
                    selected: flag(.selected), expanded: flag(.expanded), checked: checked,
                    url: details?[.url].flatMap(Self.url))
                children[element] = details.map { Self.elements($0[.visibleChildren]) + Self.elements($0[.children]) }
                    ?? Self.elements(array(element.raw, kAXChildrenAttribute))
            }
            let all = children[element] ?? []
            let end = min(all.count, offset + pageSize)
            let page = offset < end ? Array(all[offset..<end]) : []
            if insidePage.contains(element) { insidePage.formUnion(page) }
            return AccessibilityTraversalRead(node: node, children: page, nextChildOffset: end < all.count ? end : nil)
        }
    }
}
