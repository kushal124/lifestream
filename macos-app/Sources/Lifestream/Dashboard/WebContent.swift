import AppKit
import Cockpit
import SwiftUI
import UniformTypeIdentifiers
import WebKit

@MainActor final class WebContent: NSObject, ObservableObject {
    static func photoPanel(several: Bool = false) -> NSOpenPanel {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = several
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        return panel
    }

    private enum Key {
        static let lastURL = "DashboardLastURL"
        static let zoom = "DashboardPageZoom"
    }

    @Published private(set) var failing = false
    @Published private(set) var loaded = false
    @Published private(set) var lastAttempt = Date()
    @Published private(set) var restartAvailable = false
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    @Published private(set) var title = "Lifestream"

    var perform: (HostAct) async throws -> [String: Any] = { _ in [:] }
    var want: (HostAct) -> Bool = { _ in false }
    var intentReset: () -> Void = {}
    var visible: () -> Bool = { false }
    var viewChanged: (String?) -> Void = { _ in }
    var takesFiles: (_ dialog: String?) -> (([URL]) -> Void)? = { _ in nil }
    var openPanel: (NSOpenPanel, NSWindow?) async -> [URL]? = { panel, window in
        let answer = if let window { await panel.beginSheetModal(for: window) } else { panel.runModal() }
        return answer == .OK ? panel.urls : nil
    }

    let address: DashboardAddress
    let container = NSView()
    private let defaults: UserDefaults
    private let dashboardHeld: @Sendable () -> Bool
    private var webView: PageWebView?
    private var observations: [NSKeyValueObservation] = []
    private var intendedURL: URL
    private var pageReady = false
    private var pendingHash: String?
    private var state: HostState?
    private var retryTimer: Timer?
    private var recovery = WebProcessRecovery()
    private let downloads = DashboardDownloads()

    init(address: DashboardAddress, defaults: UserDefaults = .standard, launch: Bool = false, release: URL? = BundledRelease.inApp()?.folder,
         dashboardHeld: @escaping @Sendable () -> Bool = { HomeAgents.held(.dashboard) }) {
        self.address = address
        self.defaults = defaults
        self.dashboardHeld = dashboardHeld
        intendedURL = address.startURL(stored: defaults.string(forKey: Key.lastURL), launch: launch)
        super.init()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.setURLSchemeHandler(BundledPage(release: release, dashboard: DashboardAddress(port: address.port).root),
                                          forURLScheme: BundledPage.scheme)
        configuration.userContentController.addScriptMessageHandler(MessageRelay(self), contentWorld: .page, name: HostBridge.handler)
        let webView = PageWebView(frame: .zero, configuration: configuration)
        webView.takesFiles = { [weak self] in self.flatMap { $0.takesFiles(DashboardAddress.dialog(of: $0.currentURL)) } }
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.underPageBackgroundColor = NSColor(Cockpit.Color.canvas)
        webView.pageZoom = CGFloat(PageZoom.restored(defaults.object(forKey: Key.zoom) as? Double))
        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        self.webView = webView
        observations = [
            webView.observe(\.title, options: [.new]) { [weak self] _, _ in MainActor.assumeIsolated { self?.retitle() } },
            webView.observe(\.url, options: [.new]) { [weak self] view, _ in MainActor.assumeIsolated { self?.urlChanged(view.url) } },
            webView.observe(\.canGoBack, options: [.new]) { [weak self] view, _ in MainActor.assumeIsolated { self?.canGoBack = view.canGoBack } },
            webView.observe(\.canGoForward, options: [.new]) { [weak self] view, _ in MainActor.assumeIsolated { self?.canGoForward = view.canGoForward } },
        ]
    }

    static func leftInOnboarding(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.string(forKey: Key.lastURL).flatMap(URL.init(string:)).flatMap(DashboardAddress.view(of:)) == AppSection.onboardingView
    }

    func start() {
        load(intendedURL)
    }

    func close() {
        stopRetrying()
        observations.forEach { $0.invalidate() }
        observations = []
        if let webView {
            webView.stopLoading()
            let scripts = webView.configuration.userContentController
            scripts.removeScriptMessageHandler(forName: HostBridge.handler, contentWorld: .page)
            scripts.removeAllUserScripts()
            webView.navigationDelegate = nil
            webView.uiDelegate = nil
            webView.removeFromSuperview()
        }
        webView = nil
        pageReady = false
    }

    var page: PageWebView? { webView }


    var view: String? { DashboardAddress.view(of: currentURL) }

    func show(view: String) {
        if self.view == view {
            pendingHash = nil
            return
        }
        show(hash: "view=\(view)")
    }

    func show(hash: String) {
        guard loaded, !failing else {
            pendingHash = nil
            intendedURL = address.root(hash: DashboardAddress.hash(hash, over: intendedURL))
            if !failing { load(intendedURL) }
            return
        }
        guard pageReady, let webView, let script = try? HostBridge.hashScript(hash) else {
            pendingHash = hash
            return
        }
        pendingHash = nil
        webView.evaluateJavaScript(script, in: nil, in: .page) { _ in }
    }

    func picture() async -> CGImage? {
        guard let webView, let image = try? await webView.takeSnapshot(configuration: nil) else { return nil }
        return image.cgImage(forProposedRect: nil, context: nil, hints: nil)
    }

    func dropped(kind: String) {
        guard pageReady, let webView, let script = try? HostBridge.droppedScript(kind: kind) else { return }
        webView.evaluateJavaScript(script, in: nil, in: .page) { _ in }
    }

    func push(_ state: HostState) {
        self.state = state
        guard let webView, let presence = try? HostBridge.presenceScript(state) else { return }
        let scripts = webView.configuration.userContentController
        scripts.removeAllUserScripts()
        scripts.addUserScript(WKUserScript(source: presence, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        guard pageReady, let script = try? HostBridge.stateScript(state) else { return }
        webView.evaluateJavaScript(script, in: nil, in: .page) { _ in }
    }


    fileprivate func receive(_ message: WKScriptMessage, reply: @escaping @MainActor (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        let sender = HostBridge.Sender(scheme: origin.protocol, host: origin.host, port: origin.port,
                                       mainFrame: message.frameInfo.isMainFrame)
        guard let webView, message.webView === webView, HostBridge.hears(sender, address: address) else {
            return reply(nil, HostBridge.refused)
        }
        if let gesture = WindowGestures.asked(message.body) {
            webView.perform(gesture)
            return reply([String: Any](), nil)
        }
        switch HostAct.read(message.body) {
        case .failure(let refusal) where refusal.code != nil:
            reply(refusal.coded, nil)
        case .failure(let refusal):
            reply(nil, refusal.words)
        case .success(let act):
            if want(act) { return reply([String: Any](), nil) }
            let perform = perform
            Task {
                do {
                    reply(try await perform(act), nil)
                } catch {
                    reply((error as? HostRefusal ?? HostRefusal("\(error)")).answer, nil)
                }
            }
        }
    }

    private func retitle() {
        let page = webView?.title.flatMap { $0.isEmpty ? nil : $0 }
        title = failing ? "Lifestream" : page ?? "Lifestream"
    }

    private func urlChanged(_ url: URL?) {
        guard let url, address.decide(url) == .load else { return }
        intendedURL = url
        if let place = address.place(of: url) { defaults.set(place.absoluteString, forKey: Key.lastURL) }
        viewChanged(DashboardAddress.view(of: url))
    }

    private func load(_ url: URL) {
        lastAttempt = Date()
        webView?.load(URLRequest(url: url))
    }


    private func showFailure() {
        pageReady = false
        intentReset()
        failing = true
        retitle()
        startRetrying()
        let held = dashboardHeld
        Task { [weak self] in
            let available = await Task.detached { held() }.value
            self?.restartAvailable = available
        }
    }

    private func showPage() {
        loaded = true
        guard failing else { return }
        failing = false
        stopRetrying()
        retitle()
    }

    private func startRetrying() {
        guard retryTimer == nil else { return }
        let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.failing, self.visible(), self.webView?.isLoading == false else { return }
                self.load(self.intendedURL)
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        retryTimer = timer
    }

    private func stopRetrying() {
        retryTimer?.invalidate()
        retryTimer = nil
    }

    func retry() {
        webView?.stopLoading()
        load(intendedURL)
    }

    func restartDashboard() {
        Task { [weak self] in
            await HomeAgents.restart(.dashboard)
            try? await Task.sleep(for: .seconds(2))
            guard let self, self.failing else { return }
            self.retry()
        }
    }


    func reload() {
        if failing || webView?.url == nil { retry() } else { webView?.reload() }
    }

    func goBack() { webView?.goBack() }

    func goForward() { webView?.goForward() }

    var currentURL: URL {
        webView?.url.flatMap { address.decide($0) == .load ? $0 : nil } ?? intendedURL
    }

    var zoom: Double { Double(webView?.pageZoom ?? 1) }

    func setZoom(_ zoom: Double) {
        webView?.pageZoom = CGFloat(zoom)
        defaults.set(zoom, forKey: Key.zoom)
    }

    func resignFocus(in window: NSWindow?) {
        guard let window, let webView, let responder = window.firstResponder as? NSView, responder.isDescendant(of: webView) else { return }
        window.makeFirstResponder(nil)
    }
}


extension WebContent: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        let decision = address.decide(url)
        if navigationAction.targetFrame == nil {
            decisionHandler(.cancel)
            follow(navigationAction.request, decision)
            return
        }
        switch decision {
        case .load:
            decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
        case .openInBrowser:
            decisionHandler(.cancel)
            if navigationAction.targetFrame?.isMainFrame == true, let url { NSWorkspace.shared.open(url) }
        case .refuse:
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Disposition")?.lowercased() ?? ""
        decisionHandler(disposition.hasPrefix("attachment") || !navigationResponse.canShowMIMEType ? .download : .allow)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        pageReady = false
        intentReset()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let error = error as NSError
        if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
        if error.domain == WKError.errorDomain && error.code == 102 { return }
        showFailure()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        showPage()
        if let state { push(state) }
        if let hash = pendingHash, let script = try? HostBridge.hashScript(hash) {
            pendingHash = nil
            webView.evaluateJavaScript(script, in: nil, in: .page) { _ in }
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        pageReady = false
        intentReset()
        switch recovery.processTerminated(at: ProcessInfo.processInfo.systemUptime) {
        case .reload: load(intendedURL)
        case .showFailure: showFailure()
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = downloads
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = downloads
    }

    private func follow(_ request: URLRequest, _ decision: DashboardAddress.Decision) {
        switch decision {
        case .load: webView?.load(request)
        case .openInBrowser: if let url = request.url { NSWorkspace.shared.open(url) }
        case .refuse: break
        }
    }
}


extension WebContent: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        follow(navigationAction.request, address.decide(navigationAction.request.url))
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor ([URL]?) -> Void) {
        let open = openPanel
        let window = webView.window
        let panel = Self.photoPanel(several: parameters.allowsMultipleSelection)
        Task { completionHandler(await open(panel, window)) }
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
        let granted = type == .microphone && Self.mayRecord(scheme: origin.protocol, host: origin.host, port: origin.port, dashboard: address.port)
        decisionHandler(granted ? .grant : .deny)
    }

    nonisolated static func mayRecord(scheme: String, host: String, port: Int, dashboard: Int) -> Bool {
        let scheme = scheme.lowercased()
        let host = host.lowercased()
        if scheme == BundledPage.scheme { return host == BundledPage.host }
        return scheme == "http" && host == "127.0.0.1" && port == dashboard
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        guard let window = webView.window else {
            completionHandler()
            return
        }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        guard let window = webView.window else {
            completionHandler(false)
            return
        }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
    }
}

private final class MessageRelay: NSObject, WKScriptMessageHandlerWithReply {
    private weak var content: WebContent?

    init(_ content: WebContent) { self.content = content }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        MainActor.assumeIsolated {
            guard let content else { return replyHandler(nil, HostBridge.refused) }
            content.receive(message, reply: replyHandler)
        }
    }
}
