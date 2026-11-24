import AppKit
import Evidence

struct WindowInventory {
    private struct Entry {
        let pid: Int32
        let id: UInt32?
        let layer: Int?
        let alpha: Double?
        let title: String?
        let bounds: CaptureRect
    }

    private let entries: [Entry]

    init(rows: [[String: Any]]) {
        entries = rows.compactMap { item in
            guard let pid = (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                  let dictionary = item[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: dictionary) else { return nil }
            return Entry(pid: pid, id: (item[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                layer: (item[kCGWindowLayer as String] as? NSNumber)?.intValue,
                alpha: (item[kCGWindowAlpha as String] as? NSNumber)?.doubleValue,
                title: item[kCGWindowName as String] as? String,
                bounds: CaptureRect(bounds))
        }
    }

    static func read() -> Self {
        ResourceMeter.shared.measure(.capture, units: 0) {
            let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
            return Self(rows: CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? [])
        }
    }

    var selection: [DisplaySelection.Window] {
        entries.compactMap { entry in
            guard let layer = entry.layer, let alpha = entry.alpha, alpha > 0 else { return nil }
            return .init(id: entry.id, pid: entry.pid, layer: layer, bounds: entry.bounds, title: entry.title)
        }
    }

    func matchesScope(_ initial: [DisplaySelection.Window], pid: Int32, display: CaptureRect) -> Bool {
        let current = selection.filter { window in
            window.pid == pid && window.layer == 0 &&
                AccessibilityWindowCorrelation.intersects(window.bounds, display)
        }
        guard current.count == initial.count else { return false }
        return zip(initial, current).allSatisfy { original, fresh in
            guard let originalID = original.id, let freshID = fresh.id else { return false }
            return originalID == freshID && original.pid == fresh.pid && original.layer == fresh.layer &&
                AccessibilityWindowCorrelation.intersects(original.bounds, display) &&
                AccessibilityWindowCorrelation.matches(original.bounds, fresh.bounds)
        }
    }

    func visible(in display: CaptureRect?, privacy: WindowPrivacy,
        application: (Int32) -> CaptureApplication) -> [CaptureWindow] {
        var applications: [Int32: CaptureApplication] = [:]
        return entries.compactMap { entry in
            guard let id = entry.id, !privacy.excludedPIDs.contains(entry.pid),
                  display.map({ AccessibilityWindowCorrelation.intersects(entry.bounds, $0) }) ?? true
            else { return nil }
            let app = applications[entry.pid] ?? application(entry.pid)
            applications[entry.pid] = app
            guard !privacy.omits(app) else { return nil }
            var title = privacy.untitles(app) ? nil : entry.title
            var site: String?
            if privacy.browserPIDs.contains(entry.pid) {
                let page = privacy.pages[id] ?? WindowPage(mode: privacy.unreadBrowserMode, site: nil)
                guard page.mode != .exclude else { return nil }
                if page.mode != .record { title = nil }
                site = page.site
            }
            return CaptureWindow(windowID: id, title: title, application: app, bounds: entry.bounds, site: site)
        }
    }
}

struct WindowPrivacy: Equatable {
    var excludedPIDs: Set<Int32> = []
    var excluded: Set<String> = []
    var activityPIDs: Set<Int32> = []
    var activity: Set<String> = []
    var pages: [UInt32: WindowPage] = [:]
    var browserPIDs: Set<Int32> = []
    var unreadBrowserMode: RecordingMode = .record

    func omits(_ application: CaptureApplication) -> Bool {
        excludedPIDs.contains(application.pid) || application.bundleID.map(excluded.contains) == true
    }

    func untitles(_ application: CaptureApplication) -> Bool {
        activityPIDs.contains(application.pid) || application.bundleID.map(activity.contains) == true
    }
}
