import AppKit
import Cockpit
import Combine
import SwiftUI
import UserNotifications

@MainActor final class MainWindowController: NSWindowController, NSWindowDelegate {
    private static let frameName = "Lifestream Dashboard"

    let web: WebContent
    let host: MacHost
    let release: String?
    private(set) var kept = false
    private let onScreen: Bool
    private let closed: () -> Void
    private let sight: (() -> Bool)?
    private let screen: (() -> CGRect)?
    private var titled: AnyCancellable?
    private var firstShow: AnyCancellable?
    private var inFront: [() -> Void] = []
    private(set) var onboarding = false

    init(web: WebContent, host: MacHost, release: String? = nil, onScreen: Bool, sight: (() -> Bool)? = nil,
         screen: (() -> CGRect)? = nil, closed: @escaping () -> Void) {
        self.web = web
        self.host = host
        self.release = release
        self.onScreen = onScreen
        self.sight = sight
        self.screen = screen
        self.closed = closed
        let hosting = NSHostingController(rootView: MainWindow(web: web, host: host))
        hosting.sizingOptions = []
        hosting.sceneBridgingOptions = []
        let size = MainWindowSize.initial(screen: screen?().size ?? NSScreen.main?.visibleFrame.size ?? MainWindowSize.preferred)
        hosting.view.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(contentViewController: hosting)
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.titlebarSeparatorStyle = .none
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor(Cockpit.Color.canvas)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.contentMinSize = MainWindowSize.minimum
        window.setContentSize(size)
        window.center()
        window.setFrameUsingName(Self.frameName)
        window.setFrameAutosaveName(Self.frameName)
        super.init(window: window)
        window.delegate = self
        titled = web.$title.sink { [weak window] title in window?.title = title }
        web.visible = { [weak self] in self?.seen ?? false }
        web.viewChanged = { [weak self, weak host] view in
            host?.onboarding = view == AppSection.onboardingView
            if view != AppSection.onboardingView { self?.grow() }
        }
        web.takesFiles = { [weak host] dialog in host?.dropped(on: dialog) }
        web.perform = { [weak host] act in try await host?.reply(act) ?? [:] }
        web.want = { [weak host] act in host?.want(act) ?? false }
        web.intentReset = { [weak host] in host?.resetIntent() }
        host.seen = { [weak self] in self?.seen ?? false }
        host.published = { [weak web] state in web?.push(state) }
        host.asked = { [weak self] browser in self?.called(by: browser) }
        host.showPage = { [weak web] hash in web?.show(hash: hash) }
        host.window = { [weak self] in self?.window }
        host.droppedOn = { [weak web] kind in web?.dropped(kind: kind) }
        host.snapshot = { [weak web] in await web?.picture() }
        measure()
        host.onboarding = web.view == AppSection.onboardingView
        web.push(host.state)
        startHost()
        web.start()
    }

    private func startHost() {
        host.start(polling: { [weak self] in self?.seen == true && self?.web.view == AppSection.connectors.rawValue })
    }

    func keeps(carried: Bool, release: String?) -> Bool {
        !kept || (web.address.bundled == carried && (carried || release == self.release))
    }

    func drop() {
        web.close()
    }

    private func reopen() -> Bool {
        guard kept else { return false }
        kept = false
        startHost()
        return true
    }

    private func retryOnReopen(_ reopened: Bool) {
        if reopened, web.failing { web.retry() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { nil }

    var seen: Bool {
        if let sight { return sight() }
        guard let window else { return false }
        return window.isVisible && !window.isMiniaturized && window.occlusionState.contains(.visible)
    }

    func present(_ section: AppSection?) {
        let reopened = reopen()
        if let section { web.show(view: section.rawValue) }
        retryOnReopen(reopened)
        bringForward(at: section?.rawValue ?? web.view)
    }

    func present(hash: String, pictured: Bool = true) {
        host.pictureless = !pictured
        let reopened = reopen()
        web.show(hash: hash)
        retryOnReopen(reopened)
        bringForward(at: DashboardAddress.view(of: web.address.root(hash: hash)))
    }

    private func standAtOnboarding() {
        guard let window else { return }
        onboarding = true
        window.contentMinSize = MainWindowSize.onboarding
        window.setContentSize(MainWindowSize.onboarding)
        window.center()
    }

    func grow() {
        guard onboarding, let window, let visible = screen?() ?? (window.screen ?? NSScreen.main)?.visibleFrame else { return }
        onboarding = false
        if window.isVisible {
            front()
            if let page = web.page { window.makeFirstResponder(page) }
        }
        let frame = MainWindowSize.grown(from: window.frame, screen: visible)
        window.contentMinSize = MainWindowSize.minimum
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, window.isVisible else {
            window.setFrame(frame, display: true)
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = Cockpit.Duration.base
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            window.animator().setFrame(frame, display: true)
        }
    }

    private func bringForward(at view: String? = nil) {
        if view == AppSection.onboardingView, window?.isVisible != true { standAtOnboarding() }
        guard window?.isVisible == true || web.loaded || web.failing else {
            firstShow = web.$loaded.combineLatest(web.$failing).first { $0 || $1 }
                .receive(on: DispatchQueue.main)
                .sink { [weak self] _ in MainActor.assumeIsolated { self?.bringForward(at: view) } }
            return
        }
        firstShow = nil
        front()
    }

    private func front() {
        guard onScreen, let window else { return }
        AppActivation.front(window, in: NSApp)
        let waiting = inFront
        inFront = []
        waiting.forEach { $0() }
    }

    func afterFront(_ then: @escaping () -> Void) {
        guard firstShow != nil else { return then() }
        inFront.append(then)
    }

    private func called(by browser: String) {
        let elsewhere = NSWorkspace.shared.frontmostApplication?.processIdentifier != ProcessInfo.processInfo.processIdentifier
        bringForward()
        guard onScreen else { return }
        window?.orderFrontRegardless()
        guard elsewhere else { return }
        let content = UNMutableNotificationContent()
        content.title = "\(browser) is asking to connect"
        content.body = "Connect it if you just added the extension"
        Task { await NotificationGrant.post(UNNotificationRequest(identifier: "connect-request", content: content, trigger: nil)) }
    }

    private func measure() {
        guard let window else { return }
        let buttons = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].compactMap(window.standardWindowButton)
        let frame = buttons.map { $0.convert($0.bounds, to: nil) }.reduce(CGRect.null) { $0.union($1) }
        guard !frame.isNull else { return }
        let fromTop = CGRect(x: frame.minX, y: window.frame.height - frame.maxY, width: frame.width, height: frame.height)
        host.inset = HostState.Inset.of(buttons: fromTop, zoom: web.zoom, fullScreen: window.styleMask.contains(.fullScreen))
    }

    func windowDidEnterFullScreen(_ notification: Notification) { measure() }

    func windowDidExitFullScreen(_ notification: Notification) { measure() }

    func windowDidChangeOcclusionState(_ notification: Notification) { host.wake() }

    func windowDidMiniaturize(_ notification: Notification) { host.wake() }

    func windowDidDeminiaturize(_ notification: Notification) { host.wake() }

    func windowWillClose(_ notification: Notification) {
        host.stop()
        kept = true
        closed()
    }


    @objc func showSection(_ sender: NSMenuItem) {
        guard AppSection.allCases.indices.contains(sender.tag) else { return }
        web.show(view: AppSection.allCases[sender.tag].rawValue)
    }

    @objc func reloadPage(_ sender: Any?) { web.reload() }

    @objc func navigateBack(_ sender: Any?) { web.goBack() }

    @objc func navigateForward(_ sender: Any?) { web.goForward() }

    @objc func actualSize(_ sender: Any?) { zoom(PageZoom.actualSize) }

    @objc func zoomIn(_ sender: Any?) { zoom(PageZoom.zoomIn(from: web.zoom)) }

    @objc func zoomOut(_ sender: Any?) { zoom(PageZoom.zoomOut(from: web.zoom)) }

    @objc func openInBrowser(_ sender: Any?) { NSWorkspace.shared.open(web.currentURL) }

    private func zoom(_ zoom: Double) {
        web.setZoom(zoom)
        measure()
    }
}

extension MainWindowController: NSMenuItemValidation {
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        switch menuItem.action {
        case #selector(showSection(_:)):
            let shown = AppSection.allCases.indices.contains(menuItem.tag) && web.view == AppSection.allCases[menuItem.tag].rawValue
            menuItem.state = shown ? .on : .off
            return true
        case #selector(navigateBack(_:)): return web.canGoBack
        case #selector(navigateForward(_:)): return web.canGoForward
        case #selector(actualSize(_:)): return !web.failing && abs(web.zoom - PageZoom.actualSize) > 0.001
        case #selector(zoomIn(_:)): return !web.failing && web.zoom < PageZoom.steps[PageZoom.steps.count - 1]
        case #selector(zoomOut(_:)): return !web.failing && web.zoom > PageZoom.steps[0]
        default: return true
        }
    }
}
