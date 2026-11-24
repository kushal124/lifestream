import Evidence
import Foundation

struct AccessibilityWindowCandidate: Sendable {
    var bounds: CaptureRect?
    var role: String?
    var subrole: String?
    var main: Bool?
    var focused: Bool?
    var windowID: UInt32?
    init(bounds: CaptureRect?, role: String? = "AXWindow", subrole: String? = nil,
         main: Bool? = nil, focused: Bool? = nil, windowID: UInt32? = nil) {
        self.bounds = bounds
        self.role = role
        self.subrole = subrole
        self.main = main
        self.focused = focused
        self.windowID = windowID
    }

    var isContentWindow: Bool {
        if role == "AXSheet" || role == "AXDialog" { return true }
        guard role == "AXWindow" else { return false }
        return main == true || focused == true ||
            ["AXStandardWindow", "AXDialog", "AXSystemDialog", "AXFloatingWindow"].contains(subrole ?? "")
    }
}

enum AccessibilityWindowCorrelation {
    static func intersects(_ a: CaptureRect, _ b: CaptureRect) -> Bool {
        a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0 &&
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
    }
    static func matches(_ a: CaptureRect, _ b: CaptureRect, tolerance: Double = 2) -> Bool {
        [a.x, a.y, a.width, a.height, b.x, b.y, b.width, b.height].allSatisfy(\.isFinite) &&
        abs(a.x - b.x) <= tolerance && abs(a.y - b.y) <= tolerance &&
        abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
    }
    enum Resolution: Equatable, Sendable {
        case identified(windowIndex: Int, accessibilityIndex: Int)
        case matched(windowIndex: Int, accessibilityIndex: Int)
        case ambiguous(windowIndex: Int)
        case unavailable
    }
    static func resolve(windows: [CaptureWindow], pid: Int32, display: CaptureRect,
                        candidates: [AccessibilityWindowCandidate], front: UInt32? = nil) -> Resolution {
        if let front, let index = windows.firstIndex(where: {
            $0.windowID == front && $0.application?.pid == pid && intersects($0.bounds, display)
        }) {
            let found = candidates.indices.filter { candidates[$0].windowID == front }
            if found.count == 1 { return .identified(windowIndex: index, accessibilityIndex: found[0]) }
        }
        guard candidates.allSatisfy({ $0.bounds != nil }) else { return .unavailable }
        for contentWindow in [true, false] {
            for index in windows.indices {
                let window = windows[index]
                guard window.application?.pid == pid, intersects(window.bounds, display) else { continue }
                let matches = candidates.indices.filter { candidate in
                    guard let bounds = candidates[candidate].bounds else { return false }
                    return self.matches(bounds, window.bounds) && intersects(bounds, display)
                }
                guard matches.contains(where: { candidates[$0].isContentWindow == contentWindow }) else { continue }
                if matches.count > 1 { return .ambiguous(windowIndex: index) }
                if let match = matches.first { return .matched(windowIndex: index, accessibilityIndex: match) }
            }
        }
        return .unavailable
    }
}
