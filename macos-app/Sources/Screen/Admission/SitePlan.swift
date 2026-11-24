import BrowserPages
import Evidence
import Foundation

protocol BrowserPageFacts: Sendable {
    func windows(pid: Int32, bundleID: String) async -> [BrowserWindow]
}

struct LiveBrowserPages: BrowserPageFacts, Sendable {
    private let reader = BrowserPageReader.shared

    func windows(pid: Int32, bundleID: String) async -> [BrowserWindow] {
        let reader = self.reader
        return await BlockingWork.run { reader.windows(pid: pid, bundleID: bundleID) }
    }
}

enum WindowReading: Equatable, Sendable {
    case notAPage
    case page(BrowserPage)

    var page: BrowserPage? {
        if case .page(let page) = self { return page }
        return nil
    }
}

struct WindowPage: Equatable, Sendable {
    let mode: RecordingMode
    let site: String?
}

struct SitePlan: Equatable {
    private(set) var readings: [UInt32: WindowReading] = [:]
    private(set) var pages: [UInt32: WindowPage] = [:]
    private(set) var owners: [UInt32: Int32] = [:]
    private(set) var browserPIDs: Set<Int32> = []
    private(set) var unmatched: Set<UInt32> = []
    private(set) var lookPast: Set<Int32> = []
    private(set) var causes: [UInt32: PageUnknownCause] = [:]

    static let empty = SitePlan()

    mutating func add(pid: Int32, bundleID: String, cgWindows: [DisplaySelection.Window],
                      windows: [BrowserWindow], modes: RecordingModes) {
        browserPIDs.insert(pid)
        let listComplete = windows.count < BrowserPageReader.windowLimit
        if UnmatchedBrowserWindow.mayLookPast(windows: windows, listComplete: listComplete) { lookPast.insert(pid) }
        for cg in cgWindows where cg.pid == pid {
            guard let id = cg.id else { continue }
            let matches = windows.filter { window in
                window.bounds.map { AccessibilityWindowCorrelation.matches($0, cg.bounds) } ?? false
            }
            let reading: WindowReading
            if matches.count == 1 {
                reading = matches[0].shownPage.map { .page($0) } ?? .notAPage
                if reading == .page(.unknown) { causes[id] = matches[0].unknownCause }
            } else {
                reading = .page(.unknown)
                unmatched.insert(id)
                causes[id] = windows.isEmpty ? .browserDidNotAnswer
                    : matches.isEmpty ? .noAccessibilityWindow : .ambiguousAccessibilityWindow
            }
            readings[id] = reading
            owners[id] = pid
            let bounded = unmatched.contains(id) ? UnmatchedBrowserWindow.mode(windows: windows, app: bundleID,
                modes: modes, listComplete: listComplete) : nil
            let mode = bounded ?? modes.mode(app: bundleID, page: reading.page)
            var site: String?
            if mode != .exclude, case .page(.site(let page)) = reading { site = page.host }
            pages[id] = WindowPage(mode: mode, site: site)
        }
    }

    func mode(of windowID: UInt32?) -> RecordingMode {
        windowID.flatMap { pages[$0]?.mode } ?? .record
    }

    var filteredBrowsers: Set<Int32> {
        Set(pages.compactMap { id, page in page.mode == .record ? nil : owners[id] })
    }

    var keptWindows: Set<UInt32> {
        let filtered = filteredBrowsers
        return Set(pages.compactMap { id, page in
            page.mode == .record && owners[id].map(filtered.contains) == true ? id : nil
        })
    }

    static func browsers(in windows: [DisplaySelection.Window], modes: RecordingModes,
                         bundle: (Int32) -> String?) -> [(pid: Int32, bundleID: String)] {
        var seen = Set<Int32>()
        var found: [(pid: Int32, bundleID: String)] = []
        for window in windows where window.id != nil && seen.insert(window.pid).inserted {
            guard let bundleID = bundle(window.pid), Browsers.isBrowser(bundleID),
                  modes.mode(of: bundleID) != .exclude else { continue }
            found.append((window.pid, bundleID))
        }
        return found
    }

    static func read(inventory: [DisplaySelection.Window], modes: RecordingModes, pages: BrowserPageFacts,
                     bundle: (Int32) -> String?) async -> SitePlan {
        var plan = SitePlan()
        for browser in browsers(in: inventory, modes: modes, bundle: bundle) {
            let windows = await pages.windows(pid: browser.pid, bundleID: browser.bundleID)
            plan.add(pid: browser.pid, bundleID: browser.bundleID, cgWindows: inventory,
                     windows: windows, modes: modes)
        }
        return plan
    }

    var pagesByWindow: [UInt32: WindowPage] { pages }

    static func samePages(_ before: SitePlan, _ after: SitePlan) -> Bool {
        let ids = Set(before.readings.keys).union(after.readings.keys)
        return ids.allSatisfy { id in
            let was = before.readings[id]
            let now = after.readings[id]
            switch (was, now) {
            case _ where was == now:
                return true
            case (.notAPage?, nil), (nil, .notAPage?):
                return true
            case (_?, nil):
                return before.pages[id]?.mode != .record
            case (nil, _?):
                return after.owners[id].map(before.filteredBrowsers.contains) == true
            default:
                return false
            }
        }
    }

    func front(of pid: Int32, in inventory: [DisplaySelection.Window])
        -> (window: UInt32, page: WindowPage, reading: WindowReading, cause: PageUnknownCause?)? {
        guard browserPIDs.contains(pid) else { return nil }
        let ids = inventory.compactMap { $0.pid == pid && $0.layer == 0 ? $0.id : nil }
            .filter { readings[$0].map { $0 != .notAPage } ?? false }
        let matched = lookPast.contains(pid) ? ids.first(where: { !unmatched.contains($0) }) : nil
        guard let id = matched ?? ids.first,
              let page = pages[id], let reading = readings[id] else { return nil }
        return (id, page, reading, causes[id])
    }
}
