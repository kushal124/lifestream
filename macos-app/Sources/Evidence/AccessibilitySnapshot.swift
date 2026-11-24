import Foundation

public struct AccessibilitySnapshot: Codable, Equatable, Sendable {
    public var capturedAt: Date
    public var status: String
    public var nodes: [AccessibilityNode]
    public var capturedUntil: Date?
    public var targetWindowID: UInt32?
    public var targetWindowBounds: CaptureRect?
    public var windowCorrelation: String?
    public var limitReasons: [String]?
    public var visitedElements: Int?
    public var candidateWindowBounds: [CaptureRect]?
    public var candidateWindowCount: Int?
    public var scopedMatchingWindowCount: Int?

    public init(capturedAt: Date, status: String, nodes: [AccessibilityNode], capturedUntil: Date? = nil) {
        self.capturedAt = capturedAt
        self.status = status
        self.nodes = nodes
        self.capturedUntil = capturedUntil
    }
}

public struct AccessibilityNode: Codable, Equatable, Sendable {
    public var role: String
    public var text: String?
    public var bounds: CaptureRect?
    public var depth: Int
    public var subrole: String?
    public var title: String?
    public var description: String?
    public var value: String?
    public var enabled: Bool?
    public var visible: Bool?
    public var focused: Bool?
    public var selected: Bool?
    public var expanded: Bool?
    public var checked: Bool?
    public var url: String?

    public init(
        role: String,
        text: String?,
        bounds: CaptureRect?,
        depth: Int,
        subrole: String? = nil,
        title: String? = nil,
        description: String? = nil,
        value: String? = nil,
        enabled: Bool? = nil,
        visible: Bool? = nil,
        focused: Bool? = nil,
        selected: Bool? = nil,
        expanded: Bool? = nil,
        checked: Bool? = nil,
        url: String? = nil
    ) {
        self.role = role
        self.text = text
        self.bounds = bounds
        self.depth = depth
        self.subrole = subrole
        self.title = title
        self.description = description
        self.value = value
        self.enabled = enabled
        self.visible = visible
        self.focused = focused
        self.selected = selected
        self.expanded = expanded
        self.checked = checked
        self.url = url
    }
}
