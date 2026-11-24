import Evidence
import Foundation

struct AccessibilityTraversalBudget: Sendable {
    var maximumElements = 2048
    var maximumTextBytes = 262_144
    var maximumSeconds = 0.25
    var childPageSize = 32
}

struct AccessibilityTraversalRead<Element> {
    var node: AccessibilityNode?
    var children: [Element]
    var nextChildOffset: Int?
    var reasons: [AccessibilityLimitReason]
    init(node: AccessibilityNode?, children: [Element] = [], nextChildOffset: Int? = nil,
         reasons: [AccessibilityLimitReason] = []) {
        self.node = node
        self.children = children
        self.nextChildOffset = nextChildOffset
        self.reasons = reasons
    }
}

struct AccessibilityTraversalResult {
    let nodes: [AccessibilityNode]
    let reasons: [AccessibilityLimitReason]
    let visited: Int
}

enum AccessibilityTraversal {
    private struct Visit<Element> {
        let element: Element
        let depth: Int
        let offset: Int
        let parent: Element?
    }

    static func walk<Element: Hashable>(root: Element, budget: AccessibilityTraversalBudget = .init(),
        now: () -> Double,
        read: (Element, Int, Int, Int) -> AccessibilityTraversalRead<Element>) -> AccessibilityTraversalResult {
        let deadline = now() + budget.maximumSeconds
        var queue = [Visit(element: root, depth: 0, offset: 0, parent: nil)]
        var cursor = 0
        var scheduled: Set<Element> = [root]
        var visited = 0
        var captured: [Element: AccessibilityNode] = [:]
        var childrenByParent: [Element: [Element]] = [:]
        var reasons = Set<AccessibilityLimitReason>()
        var textBytes = 0
        while cursor < queue.count {
            guard now() < deadline else {
                reasons.insert(.walkDeadline)
                break
            }
            let visit = queue[cursor]
            cursor += 1
            let element = visit.element
            let depth = visit.depth
            let offset = visit.offset
            if offset == 0 {
                guard visited < budget.maximumElements else {
                    reasons.insert(.elementBudget)
                    break
                }
                visited += 1
                if let parent = visit.parent { childrenByParent[parent, default: []].append(element) }
            }
            let result = read(element, depth, offset, budget.childPageSize)
            reasons.formUnion(result.reasons)
            if offset == 0, var node = result.node {
                let fields = [node.title, node.description, node.value, node.url]
                let bytes = fields.compactMap { $0 }.reduce(0) { $0 + $1.utf8.count }
                let legacyBytes = fields.allSatisfy { $0 == nil } ? (node.text?.utf8.count ?? 0) : 0
                if textBytes + bytes + legacyBytes > budget.maximumTextBytes {
                    reasons.insert(.textByteBudget)
                    node.title = nil
                    node.description = nil
                    node.value = nil
                    node.url = nil
                    node.text = nil
                } else {
                    textBytes += bytes + legacyBytes
                }
                captured[element] = node
            }
            for child in result.children where scheduled.insert(child).inserted {
                queue.append(Visit(element: child, depth: depth + 1, offset: 0, parent: element))
            }
            if let next = result.nextChildOffset, next > offset {
                queue.append(Visit(element: element, depth: depth, offset: next, parent: visit.parent))
            }
            if queue.count - cursor > budget.maximumElements * 2 {
                reasons.insert(.frontierBudget)
                break
            }
        }
        var nodes: [AccessibilityNode] = []
        var stack: [(Element, Int)] = [(root, 0)]
        while let (element, depth) = stack.popLast() {
            var childDepth = depth
            if var node = captured[element] {
                node.depth = depth
                nodes.append(node)
                childDepth += 1
            }
            for child in (childrenByParent[element] ?? []).reversed() { stack.append((child, childDepth)) }
        }
        return AccessibilityTraversalResult(nodes: nodes, reasons: reasons.sorted { $0.rawValue < $1.rawValue },
            visited: visited)
    }
}
