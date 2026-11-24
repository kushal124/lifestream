import AppKit
import Cockpit
import CoreText
import SwiftUI

@MainActor final class DragPanel {
    struct Content: Equatable {
        let title: String
        let lines: [String]
        var after: String? = nil
        let name: String
        let icon: URL
        let beside: String
    }

    nonisolated static func switchOn(_ grant: Grant, app: URL) -> Content {
        let after: String? = if grant.reopens {
            "When macOS asks, choose **Quit & Reopen**. Lifestream comes back right here."
        } else if grant == .fullDiskAccess || grant == .microphone {
            "If macOS offers to quit Lifestream, choose **Later**."
        } else {
            nil
        }
        return Content(title: "Turn on \(grant.title) for Lifestream", lines: ["Find **Lifestream** in this list.", "Turn on its switch."],
                       after: after, name: "Lifestream", icon: app, beside: SystemSettings.id)
    }

    struct Screen {
        var front: @MainActor () -> String?
        var window: @MainActor (String) -> CGRect?
        var every: Duration = .milliseconds(100)

        static let live = Screen(front: { NSWorkspace.shared.frontmostApplication?.bundleIdentifier },
                                 window: { DragPanel.frontWindow(of: $0) })
        static let none = Screen(front: { nil }, window: { _ in nil })
    }

    private(set) var shown: Content?
    private(set) var standing = false
    private var panel: NSPanel?
    private var watching: [NSObjectProtocol] = []
    private var looking: Task<Void, Never>?
    private let onScreen: Bool
    private let screen: Screen

    init(onScreen: Bool = false, screen: Screen = .none) {
        self.onScreen = onScreen
        self.screen = screen
    }

    func show(_ content: Content) {
        close()
        let panel = Self.make(content) { [weak self] in self?.close() }
        self.panel = panel
        shown = content
        watching = [
            NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.look(content) }
            },
        ]
        look(content)
        let every = screen.every
        looking = Task { [weak self] in
            while true {
                try? await Task.sleep(for: every)
                guard !Task.isCancelled, let self, self.shown == content else { return }
                self.look(content)
            }
        }
    }

    func close() {
        looking?.cancel()
        looking = nil
        panel?.close()
        panel = nil
        shown = nil
        standing = false
        watching.forEach(NSWorkspace.shared.notificationCenter.removeObserver)
        watching = []
    }

    private func look(_ content: Content) {
        guard shown == content, let panel else { return }
        if screen.front() == content.beside, screen.window(content.beside) != nil {
            if !standing { stand(panel, beside: content.beside) }
        } else if standing {
            if onScreen { panel.orderOut(nil) }
            standing = false
        }
    }

    private func stand(_ panel: NSPanel, beside app: String) {
        place(panel, beside: app)
        if onScreen { panel.orderFrontRegardless() }
        standing = true
    }

    static func make(_ content: Content, close: @escaping @MainActor () -> Void) -> NSPanel {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: DragPanelContent.width, height: 200),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = content.title
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let hosting = FirstPressHosting(rootView: DragPanelContent(content: content, close: close))
        panel.contentView = hosting
        panel.setContentSize(hosting.fittingSize)
        return panel
    }

    private func place(_ panel: NSPanel, beside app: String) {
        guard let primary = NSScreen.screens.first else { return }
        let window = screen.window(app).map {
            CGRect(x: $0.minX, y: primary.frame.maxY - $0.maxY, width: $0.width, height: $0.height)
        }
        let screen = window.flatMap { window in NSScreen.screens.first { $0.frame.contains(CGPoint(x: window.midX, y: window.midY)) } }
            ?? NSScreen.main ?? primary
        panel.setFrameOrigin(Self.origin(of: panel.frame.size, beside: window, visible: screen.visibleFrame))
    }

    nonisolated static func origin(of size: CGSize, beside window: CGRect?, visible: CGRect) -> CGPoint {
        let gap: CGFloat = 12
        guard let window else { return CGPoint(x: visible.minX + 2 * gap, y: visible.minY + 2 * gap) }
        let x: CGFloat
        if window.minX - gap - size.width >= visible.minX {
            x = window.minX - gap - size.width
        } else if window.maxX + gap + size.width <= visible.maxX {
            x = window.maxX + gap
        } else {
            x = max(visible.minX, window.minX + gap)
        }
        let inside = x > window.minX && x < window.maxX
        let y = (inside ? window.minY + gap : window.minY)
        return CGPoint(x: x, y: min(max(y, visible.minY), visible.maxY - size.height))
    }

    static func frontWindow(of app: String) -> CGRect? {
        guard let pid = NSRunningApplication.runningApplications(withBundleIdentifier: app).first?.processIdentifier,
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else { return nil }
        for window in windows where (window[kCGWindowOwnerPID as String] as? pid_t) == pid && (window[kCGWindowLayer as String] as? Int) == 0 {
            if let bounds = window[kCGWindowBounds as String] as? NSDictionary, let rect = CGRect(dictionaryRepresentation: bounds) { return rect }
        }
        return nil
    }
}

struct DragPanelContent: View {
    static let width = DragPanelFace.width
    let content: DragPanel.Content
    var close: @MainActor () -> Void = {}

    var body: some View {
        _ = Geist.registered
        return DragPanelFace(title: content.title, steps: content.lines, after: content.after,
                             icon: Image(nsImage: NSWorkspace.shared.icon(forFile: content.icon.path)), name: content.name, close: close)
    }
}

enum Geist {
    static let file = BundledPage.folder().appendingPathComponent("design/river/geist.woff2")
    static let registered: Bool = CTFontManagerRegisterFontsForURL(file as CFURL, .process, nil)
}

private final class FirstPressHosting<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
