import AppKit
import Darwin
import WebKit

@MainActor final class PageSpeed: NSObject, WKNavigationDelegate {
    private let window: NSWindow
    private let probe: String
    private var web: WKWebView?
    private var loading: CheckedContinuation<Void, Never>?
    private var loads = 0

    private let most = UInt64(ProcessInfo.processInfo.environment["PAGE_SPEED_MAX_MB"].flatMap(UInt64.init) ?? 6000) * 1_000_000

    init(probe: String) {
        self.probe = probe
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .resizable],
                          backing: .buffered, defer: false)
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        super.init()
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.watchMemory() }
        }
    }

    private func makeWeb(store: WKWebsiteDataStore) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = store
        if ProcessInfo.processInfo.environment["PAGE_SPEED_SCREEN_RATE"] == "1" { atScreenRate(configuration.preferences) }
        configuration.userContentController.addUserScript(WKUserScript(source: probe, injectionTime: .atDocumentStart,
                                                                       forMainFrameOnly: true, in: .page))
        let view = WKWebView(frame: window.contentLayoutRect, configuration: configuration)
        if view.responds(to: NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")) {
            view.setValue(false, forKey: "windowOcclusionDetectionEnabled")
        }
        view.navigationDelegate = self
        window.contentView = view
        window.orderFrontRegardless()
        return view
    }

    func open(_ url: URL, fresh: Bool) async {
        if fresh || web == nil {
            if let web { end(web) }
            web = makeWeb(store: fresh ? .nonPersistent() : .default())
        }
        await withCheckedContinuation { continuation in
            loading = continuation
            web?.load(URLRequest(url: url))
            giveUp()
        }
    }

    func reload() async {
        await withCheckedContinuation { continuation in
            loading = continuation
            web?.reload()
            giveUp()
        }
    }

    private func giveUp() {
        loads += 1
        let mine = loads
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
            if self?.loads == mine { self?.finishLoad() }
        }
    }

    func run(_ js: String) async -> [String: Any] {
        guard let web else { return ["error": "no page"] }
        return await withCheckedContinuation { continuation in
            var answered = false
            let finish = { (value: [String: Any]) in
                guard !answered else { return }
                answered = true
                continuation.resume(returning: value)
            }
            Task { @MainActor in
                do {
                    let value = try await web.callAsyncJavaScript("return JSON.stringify(await (\(js))) ?? 'null';", contentWorld: .page)
                    finish(["json": value as? String ?? "null"])
                } catch {
                    finish(["error": "\(error)"])
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 90) {
                guard !answered else { return }
                self.end(web)
                finish(["error": "no answer in 90 s"])
            }
        }
    }

    private func end(_ view: WKWebView) {
        let end = NSSelectorFromString("_killWebContentProcess")
        if view.responds(to: end) { view.perform(end) }
    }

    private func watchMemory() {
        guard footprint() > most, let web else { return }
        end(web)
        FileHandle.standardError.write(Data("page-speed: the web process passed \(most / 1_000_000) MB and was ended\n".utf8))
    }

    func windowState() -> [String: Any] {
        ["visible": window.isVisible, "occluded": !window.occlusionState.contains(.visible), "screen": window.screen?.localizedName ?? "none",
         "onActiveSpace": window.isOnActiveSpace]
    }

    func footprint() -> UInt64 {
        webUsage()?.ri_phys_footprint ?? 0
    }

    func usage() -> [String: Any] {
        guard let usage = webUsage() else { return ["footprint": 0, "cpuNs": 0] }
        var base = mach_timebase_info_data_t()
        mach_timebase_info(&base)
        let ticks = Double(usage.ri_user_time + usage.ri_system_time)
        return ["footprint": usage.ri_phys_footprint, "cpuNs": ticks * Double(base.numer) / Double(base.denom)]
    }

    private func webUsage() -> rusage_info_v4? {
        guard let pid = (web?.value(forKey: "_webProcessIdentifier") as? NSNumber)?.int32Value, pid > 0 else { return nil }
        var usage = rusage_info_v4()
        let read = withUnsafeMutablePointer(to: &usage) { pointer in
            pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
        }
        return read == 0 ? usage : nil
    }

    private func inWindow(x: Double, y: Double) -> NSPoint? {
        guard let web else { return nil }
        return web.convert(NSPoint(x: x, y: web.isFlipped ? y : web.bounds.height - y), to: nil)
    }

    private func mouse(_ type: NSEvent.EventType, at point: NSPoint) -> NSEvent? {
        NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                           windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: type == .mouseMoved ? 0 : 1,
                           pressure: type == .leftMouseDown ? 1 : 0)
    }

    func move(x: Double, y: Double) {
        guard let web, let point = inWindow(x: x, y: y), let moved = mouse(.mouseMoved, at: point) else { return }
        web.mouseMoved(with: moved)
    }

    func press(x: Double, y: Double) {
        guard let web, let point = inWindow(x: x, y: y), let down = mouse(.leftMouseDown, at: point),
              let up = mouse(.leftMouseUp, at: point) else { return }
        web.mouseDown(with: down)
        web.mouseUp(with: up)
    }

    func key(text: String, code: UInt16) {
        guard let web else { return }
        window.makeFirstResponder(web)
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            guard let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                               windowNumber: window.windowNumber, context: nil, characters: text,
                                               charactersIgnoringModifiers: text, isARepeat: false, keyCode: code) else { continue }
            if type == .keyDown { web.keyDown(with: event) } else { web.keyUp(with: event) }
        }
    }

    func wheel(x: Double, y: Double, dy: Int32, times: Int, everyMs: Int) async {
        guard let web, let point = inWindow(x: x, y: y) else { return }
        let onScreen = window.convertPoint(toScreen: point)
        let top = (NSScreen.screens.first?.frame.height ?? 0) - onScreen.y
        for _ in 0..<times {
            guard let wheel = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0) else { return }
            wheel.location = CGPoint(x: onScreen.x, y: top)
            if let event = NSEvent(cgEvent: wheel) { web.scrollWheel(with: event) }
            try? await Task.sleep(nanoseconds: UInt64(everyMs) * 1_000_000)
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        MainActor.assumeIsolated { finishLoad() }
    }

    nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        MainActor.assumeIsolated { finishLoad() }
    }

    nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        MainActor.assumeIsolated { finishLoad() }
    }

    nonisolated func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        MainActor.assumeIsolated { finishLoad() }
    }

    private func finishLoad() {
        loading?.resume()
        loading = nil
    }
}

@MainActor func atScreenRate(_ preferences: WKPreferences) {
    let list = NSSelectorFromString("_features"), set = NSSelectorFromString("_setEnabled:forFeature:")
    guard WKPreferences.responds(to: list), let method = class_getInstanceMethod(WKPreferences.self, set),
          let features = (WKPreferences.self as AnyObject).perform(list)?.takeUnretainedValue() as? [NSObject],
          let feature = features.first(where: { $0.value(forKey: "key") as? String == "PreferPageRenderingUpdatesNear60FPSEnabled" })
    else { return }
    typealias SetEnabled = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
    unsafeBitCast(method_getImplementation(method), to: SetEnabled.self)(preferences, set, false, feature)
}

func answer(_ value: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])) ?? Data("{\"error\":\"unwritable\"}".utf8)
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
guard CommandLine.arguments.count > 1, let probe = try? String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8) else {
    FileHandle.standardError.write(Data("usage: page-speed <speed-probe.js>\n".utf8))
    exit(2)
}
let speed = MainActor.assumeIsolated { PageSpeed(probe: probe) }
Thread.detachNewThread {
    while let line = readLine() {
        guard let command = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] else { continue }
        let done = DispatchSemaphore(value: 0)
        Task { @MainActor in
            switch command["cmd"] as? String {
            case "open":
                await speed.open(URL(string: command["url"] as? String ?? "about:blank")!, fresh: command["fresh"] as? Bool ?? false)
                answer(["ok": true])
            case "reload":
                await speed.reload()
                answer(["ok": true])
            case "run": answer(await speed.run(command["js"] as? String ?? "null"))
            case "footprint": answer(["value": speed.footprint()])
            case "window": answer(speed.windowState())
            case "usage": answer(speed.usage())
            case "move":
                speed.move(x: command["x"] as? Double ?? 0, y: command["y"] as? Double ?? 0)
                answer(["ok": true])
            case "press":
                speed.press(x: command["x"] as? Double ?? 0, y: command["y"] as? Double ?? 0)
                answer(["ok": true])
            case "key":
                speed.key(text: command["text"] as? String ?? "", code: UInt16(command["code"] as? Int ?? 0))
                answer(["ok": true])
            case "wheel":
                await speed.wheel(x: command["x"] as? Double ?? 0, y: command["y"] as? Double ?? 0, dy: Int32(command["dy"] as? Int ?? 0),
                                  times: command["times"] as? Int ?? 0, everyMs: command["everyMs"] as? Int ?? 16)
                answer(["ok": true])
            case "quit": exit(0)
            default: answer(["error": "unknown command"])
            }
            done.signal()
        }
        done.wait()
    }
    exit(0)
}
app.activate(ignoringOtherApps: true)
app.run()
