import Evidence
import Foundation

enum DisplaySelection {
    struct Display: Equatable, Sendable {
        let id: UInt32
        let bounds: CaptureRect
    }

    struct Window: Equatable, Sendable {
        let id: UInt32?
        let pid: Int32
        let layer: Int
        let bounds: CaptureRect
        let title: String?

        init(id: UInt32? = nil, pid: Int32, layer: Int, bounds: CaptureRect, title: String? = nil) {
            self.id = id
            self.pid = pid
            self.layer = layer
            self.bounds = bounds
            self.title = title
        }
    }

    struct Selection: Equatable, Sendable {
        let displayIDs: [UInt32]
        let provenance: CaptureDisplaySelection
    }

    static func select(displays: [Display], windows: [Window], foregroundPID: Int32,
                       primaryDisplayID: UInt32, allDisplays: Bool = false) -> Selection {
        let available = displays.filter { valid($0.bounds) }.sorted { $0.id < $1.id }
        func result(_ ids: [UInt32], _ reason: String) -> Selection {
            Selection(displayIDs: ids, provenance: CaptureDisplaySelection(
                policy: allDisplays ? "all-displays" : "relevant-display", reason: reason,
                availableCount: available.count))
        }
        guard !available.isEmpty else { return result([], "no-valid-display") }
        if allDisplays { return result(available.map(\.id), "explicit-all-displays") }
        for window in windows where window.pid == foregroundPID && window.layer == 0 && valid(window.bounds) {
            let x = window.bounds.x + window.bounds.width / 2
            let y = window.bounds.y + window.bounds.height / 2
            let matches = available.filter {
                x >= $0.bounds.x && x < $0.bounds.x + $0.bounds.width &&
                y >= $0.bounds.y && y < $0.bounds.y + $0.bounds.height
            }
            if let selected = matches.first(where: { $0.id == primaryDisplayID }) ?? matches.first {
                return result([selected.id], "foreground-window-midpoint")
            }
        }
        if let primary = available.first(where: { $0.id == primaryDisplayID }) {
            return result([primary.id], "primary-display-fallback")
        }
        return result([available[0].id], "stable-display-fallback")
    }

    private static func valid(_ rect: CaptureRect) -> Bool {
        rect.x.isFinite && rect.y.isFinite && rect.width.isFinite && rect.height.isFinite &&
        rect.width > 0 && rect.height > 0 && (rect.x + rect.width).isFinite && (rect.y + rect.height).isFinite
    }
}
