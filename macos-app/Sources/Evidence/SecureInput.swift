import Foundation

public enum SecureFieldReading: Equatable, Sendable {
    case none
    case focused
    case inFrontWindow
    case unreadable
}

public enum SecureInputRule {
    public static func withheld(secureInput: Bool, field: () -> SecureFieldReading) -> CaptureGapReason? {
        guard secureInput else { return nil }
        switch field() {
        case .none: return nil
        case .focused: return .secureFieldFocused
        case .inFrontWindow: return .secureFieldInFrontWindow
        case .unreadable: return .secureInputEnabled
        }
    }
}

public final class SecureFieldOnce {
    private let reader: () -> SecureFieldReading
    private var reading: SecureFieldReading?

    public init(read: @escaping () -> SecureFieldReading) {
        reader = read
    }

    public func seed(_ reading: SecureFieldReading) {
        if self.reading == nil { self.reading = reading }
    }

    public func read() -> SecureFieldReading {
        if let reading { return reading }
        let fresh = reader()
        reading = fresh
        return fresh
    }
}

public struct SecureFieldNode<Node> {
    public let role: String?
    public let subrole: String?
    public let children: [Node]

    public init(role: String?, subrole: String?, children: [Node]) {
        self.role = role
        self.subrole = subrole
        self.children = children
    }
}

public enum SecureFieldLookup<Node> {
    case found(Node)
    case absent
    case failed
}

public protocol SecureFieldTree {
    associatedtype Node
    func focusedElement() -> SecureFieldLookup<Node>
    func frontWindow() -> SecureFieldLookup<Node>
    func read(_ node: Node) -> SecureFieldNode<Node>?
}

public struct SecureFieldSearch<Tree: SecureFieldTree> {
    public static var secureRole: String { "AXSecureTextField" }
    public static var webArea: String { "AXWebArea" }
    public static var nodeBudget: Int { 1000 }
    public static var deadline: Double { 0.100 }

    let tree: Tree
    let deadline: Double
    let now: () -> Double

    public init(tree: Tree, deadline: Double, now: @escaping () -> Double) {
        self.tree = tree
        self.deadline = deadline
        self.now = now
    }

    public func read() -> SecureFieldReading {
        switch tree.focusedElement() {
        case .failed:
            return .unreadable
        case .found(let focused):
            guard let node = tree.read(focused) else { return .unreadable }
            if Self.isSecure(node) { return .focused }
        case .absent:
            break
        }
        let window: Tree.Node
        switch tree.frontWindow() {
        case .failed: return .unreadable
        case .absent: return .none
        case .found(let found): window = found
        }
        var queue = [window]
        var head = 0
        while head < queue.count {
            guard head < Self.nodeBudget, now() < deadline else { return .unreadable }
            guard let node = tree.read(queue[head]) else { return .unreadable }
            head += 1
            if Self.isSecure(node) { return .inFrontWindow }
            if node.role == Self.webArea { continue }
            queue.append(contentsOf: node.children)
        }
        return .none
    }

    static func isSecure(_ node: SecureFieldNode<Tree.Node>) -> Bool {
        node.role == secureRole || node.subrole == secureRole
    }
}
