import CoreGraphics
import Evidence
import Foundation

struct WindowServerSnapshot: Equatable {
    let displays: [UInt32: CaptureRect]
    let owners: [UInt32: Int32]
    let pixels: [UInt32: [Int]]

    func proves(_ now: WindowServerSnapshot) -> Bool {
        guard now.displays == displays, now.pixels == pixels else { return false }
        let earlier = Set(owners.values)
        guard now.owners.values.allSatisfy(earlier.contains) else { return false }
        return Set(owners.compactMap { id, pid in now.owners[id] == pid ? pid : nil }) == earlier
    }

    static func read() -> WindowServerSnapshot? {
        ResourceMeter.shared.measure(.capture, units: 0) { take() }
    }

    private static func take() -> WindowServerSnapshot? {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success else { return nil }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success,
              let rows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] else { return nil }
        var displays: [UInt32: CaptureRect] = [:]
        var pixels: [UInt32: [Int]] = [:]
        for id in ids.prefix(Int(count)) {
            guard let mode = CGDisplayCopyDisplayMode(id) else { return nil }
            displays[id] = CaptureRect(CGDisplayBounds(id))
            pixels[id] = [mode.pixelWidth, mode.pixelHeight]
        }
        var owners: [UInt32: Int32] = [:]
        for row in rows {
            guard let id = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  let pid = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value else { return nil }
            owners[id] = pid
        }
        return WindowServerSnapshot(displays: displays, owners: owners, pixels: pixels)
    }
}

@MainActor
final class ShareableContentCache<Content> {
    private let read: () -> WindowServerSnapshot?
    private let fetch: () async throws -> Content
    private let windows: (Content) -> Set<UInt32>
    private var last: (content: Content, snapshot: WindowServerSnapshot, windows: Set<UInt32>)?

    init(read: @escaping () -> WindowServerSnapshot?, fetch: @escaping () async throws -> Content,
         windows: @escaping (Content) -> Set<UInt32>) {
        self.read = read
        self.fetch = fetch
        self.windows = windows
    }

    func content(listing kept: Set<UInt32>) async throws -> Content {
        let now = read()
        if let last, let now, last.snapshot.proves(now), kept.isSubset(of: last.windows) { return last.content }
        last = nil
        let content = try await fetch()
        if let now { last = (content, now, windows(content)) }
        return content
    }
}
