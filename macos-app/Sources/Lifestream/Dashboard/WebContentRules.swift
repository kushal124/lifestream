import Foundation

enum PageZoom {
    static let steps: [Double] = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
    static let actualSize = 1.0

    static func zoomIn(from current: Double) -> Double {
        steps.first { $0 > current + 0.001 } ?? steps[steps.count - 1]
    }

    static func zoomOut(from current: Double) -> Double {
        steps.last { $0 < current - 0.001 } ?? steps[0]
    }

    static func restored(_ stored: Double?) -> Double {
        guard let stored, stored.isFinite, stored >= steps[0], stored <= steps[steps.count - 1] else {
            return actualSize
        }
        return stored
    }
}

struct WebProcessRecovery {
    enum Action: Equatable { case reload, showFailure }

    let window: TimeInterval
    private var lastReload: TimeInterval?

    init(window: TimeInterval = 60) { self.window = window }

    mutating func processTerminated(at now: TimeInterval) -> Action {
        if let lastReload, now - lastReload < window { return .showFailure }
        lastReload = now
        return .reload
    }
}
