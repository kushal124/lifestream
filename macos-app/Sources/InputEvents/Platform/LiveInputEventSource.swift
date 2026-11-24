import AppKit
import ApplicationServices
import BrowserPages
import Carbon
import Darwin
import Evidence
import Foundation
import os

final class LiveInputEventSource: InputEventSource, @unchecked Sendable {
    static let secureInputInterval = 0.25
    static let pageInterval = 0.25

    private var tap: EventTap?
    private var workspaceObservers: [NSObjectProtocol] = []
    private var distributedObservers: [NSObjectProtocol] = []
    private var secureInputPoll: DispatchSourceTimer?
    private var secureInput = false
    private let pageQueue = DispatchQueue(label: "org.lifestreamprotocol.input-events.pages", qos: .utility)
    private let pages = BrowserPageReader.shared
    private let pageState = OSAllocatedUnfairLock(uncheckedState: PageState())

    private struct PageState {
        var modes = RecordingModes.defaults
        var frontmost: (pid: Int32, bundleID: String)?
        var last: [Int32: InputPageRead] = [:]
        var poll: DispatchSourceTimer?
        var polling = false

        var pollable: (pid: Int32, bundleID: String)? {
            guard let front = frontmost, Browsers.isBrowser(front.bundleID),
                  modes.mode(of: front.bundleID) != .exclude else { return nil }
            return front
        }

        mutating func armPoll() {
            guard let poll else { return }
            let wanted = pollable != nil
            guard wanted != polling else { return }
            polling = wanted
            if wanted {
                poll.schedule(deadline: .now() + LiveInputEventSource.pageInterval,
                              repeating: LiveInputEventSource.pageInterval, leeway: .milliseconds(25))
            } else {
                poll.schedule(deadline: .distantFuture)
            }
        }
    }

    func setModes(_ modes: RecordingModes) {
        pageState.withLockUnchecked { state in
            state.modes = modes
            state.armPoll()
        }
    }

    func openingState() -> InputOpeningState {
        let session = session()
        secureInput = IsSecureEventInputEnabled()
        let front = NSWorkspace.shared.frontmostApplication
        pageState.withLockUnchecked { state in
            state.frontmost = front.flatMap { app in app.bundleIdentifier.map { (app.processIdentifier, $0) } }
            state.armPoll()
        }
        return InputOpeningState(
            inputMonitoring: CGPreflightListenEventAccess(), accessibility: AXIsProcessTrusted(),
            screenLocked: session.screenLocked, onConsole: session.onConsole, secureInput: secureInput,
            layout: Self.layout(),
            frontmost: front.flatMap { app in Self.name(of: app).map { (app.processIdentifier, $0) } })
    }

    func start(into buffer: InputEventBuffer) -> Bool {
        let tap = EventTap(buffer: buffer)
        let listens = tap.start()
        self.tap = tap
        observeWorkspace(buffer)
        observeDistributed(buffer)
        pollSecureInput(buffer)
        pollPages(buffer)
        return listens
    }

    func listen() -> Bool {
        tap?.start() ?? false
    }

    func stop() {
        let workspace = NSWorkspace.shared.notificationCenter
        for observer in workspaceObservers { workspace.removeObserver(observer) }
        workspaceObservers = []
        let distributed = DistributedNotificationCenter.default()
        for observer in distributedObservers { distributed.removeObserver(observer) }
        distributedObservers = []
        secureInputPoll?.cancel()
        secureInputPoll = nil
        pageState.withLockUnchecked { state in
            state.poll?.cancel()
            state.poll = nil
            state.polling = false
        }
        pageQueue.sync {}
        tap?.stop()
        tap = nil
    }

    func processName(_ pid: Int32) -> String? {
        Self.processName(pid)
    }

    static func processName(_ pid: Int32) -> String? {
        if let app = NSRunningApplication(processIdentifier: pid), let name = Self.name(of: app) { return name }
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { return nil }
        let executable = URL(fileURLWithPath: String(cString: path)).lastPathComponent
        return executable.isEmpty ? nil : "proc:\(executable)"
    }

    func session() -> (screenLocked: Bool, onConsole: Bool) {
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        return (session?["CGSSessionScreenIsLocked"] as? Bool ?? false,
                session?[kCGSessionOnConsoleKey as String] as? Bool ?? true)
    }


    private func observeWorkspace(_ buffer: InputEventBuffer) {
        let center = NSWorkspace.shared.notificationCenter
        let activate = center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil,
                                          queue: .main) { notification in
            guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            else { return }
            self.pageState.withLockUnchecked { state in
                state.frontmost = app.bundleIdentifier.map { (app.processIdentifier, $0) }
                state.armPoll()
            }
            buffer.append(.activate(pid: app.processIdentifier, name: Self.name(of: app), at: Date()))
        }
        let terminate = center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil,
                                           queue: .main) { notification in
            guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            else { return }
            _ = self.pageState.withLockUnchecked { $0.last.removeValue(forKey: app.processIdentifier) }
            buffer.append(.terminated(pid: app.processIdentifier))
        }
        let active = center.addObserver(forName: NSWorkspace.sessionDidBecomeActiveNotification, object: nil,
                                        queue: .main) { _ in buffer.append(.onConsole(true, at: Date())) }
        let inactive = center.addObserver(forName: NSWorkspace.sessionDidResignActiveNotification, object: nil,
                                          queue: .main) { _ in buffer.append(.onConsole(false, at: Date())) }
        workspaceObservers = [activate, terminate, active, inactive]
    }

    private func observeDistributed(_ buffer: InputEventBuffer) {
        let center = DistributedNotificationCenter.default()
        let locked = center.addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil,
                                        queue: .main) { _ in buffer.append(.screenLocked(true, at: Date())) }
        let unlocked = center.addObserver(forName: Notification.Name("com.apple.screenIsUnlocked"), object: nil,
                                          queue: .main) { _ in buffer.append(.screenLocked(false, at: Date())) }
        let layout = center.addObserver(
            forName: Notification.Name(kTISNotifySelectedKeyboardInputSourceChanged as String), object: nil,
            queue: .main) { _ in buffer.append(.layout(Self.layout(), at: Date())) }
        distributedObservers = [locked, unlocked, layout]
    }

    private func pollSecureInput(_ buffer: InputEventBuffer) {
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + Self.secureInputInterval, repeating: Self.secureInputInterval,
                       leeway: .milliseconds(25))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            let on = IsSecureEventInputEnabled()
            guard on != secureInput else { return }
            secureInput = on
            buffer.append(.secureInput(on, at: Date()))
        }
        secureInputPoll = timer
        timer.resume()
    }

    private func pollPages(_ buffer: InputEventBuffer) {
        let timer = DispatchSource.makeTimerSource(queue: pageQueue)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            guard let front = pageState.withLockUnchecked({ $0.pollable }) else { return }
            let window = pages.focusedWindow(pid: front.pid, bundleID: front.bundleID)
            let read: InputPageRead = window.map { $0.shownPage.map { .page($0) } ?? .notAPage }
                ?? .page(.unknown)
            let changed = pageState.withLockUnchecked { state -> Bool in
                guard state.last[front.pid] != read else { return false }
                if state.last.count >= 64 { state.last.removeAll() }
                state.last[front.pid] = read
                return true
            }
            if changed { buffer.append(.page(pid: front.pid, read: read, at: Date())) }
        }
        timer.resume()
        pageState.withLockUnchecked { state in
            state.poll = timer
            state.armPoll()
        }
    }


    static func name(of app: NSRunningApplication) -> String? {
        if let bundle = app.bundleIdentifier { return bundle }
        return app.executableURL.map { "proc:\($0.lastPathComponent)" }
    }

    static func layout() -> String {
        guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue(),
              let pointer = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else { return "unknown" }
        return Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue() as String
    }
}
