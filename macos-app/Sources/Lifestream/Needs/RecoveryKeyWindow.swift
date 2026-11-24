import AppKit
import Cockpit
import Combine
import SwiftUI

@MainActor final class RecoveryKeyWindow: NSObject, NSWindowDelegate {
    static let title = "Recovery key"
    static let unsavedClose = "This key isn't your recovery key yet."
    static let unsavedCloseDetail = "Press I've saved it to finish."
    static let notAnswering = "Lifestream isn't answering."

    enum Closing: Equatable {
        case goBack, discard
    }

    let recovery: RecoveryKey
    let needs: NeedsModel
    private(set) var window: NSWindow?
    var onScreen = true
    var browse: (URL) -> Void = { NSWorkspace.shared.open($0) }
    lazy var ask: (NSWindow) async -> Closing = { window in await Self.askClosing(over: window) }
    lazy var tell: (NSWindow, String) async -> Void = { window, words in await Self.tell(words, over: window) }
    private var closing: Task<Bool, Never>?
    private var uninstall: CheckedContinuation<Uninstall.KeyStep, Never>?
    private var watching: AnyCancellable?

    init(needs: NeedsModel) {
        self.needs = needs
        recovery = needs.recovery
        super.init()
        recovery.choose = { [weak self] name in await RecoveryKeyFile.choose(name, over: self?.window) }
        watching = recovery.$face.sink { [weak self] face in
            switch face {
            case .saved, .savedKey: Task { @MainActor in self?.leave(.saved) }
            default: break
            }
        }
    }

    func beforeUninstall() async -> Uninstall.KeyStep {
        guard uninstall == nil else { return .cancelled }
        await needs.read()
        guard needs.reached, let vault = needs.vault else { return .unsaved }
        guard vault.keyID != nil else { return .saved }
        switch RecoveryKey.face(vault, reached: true, need: needs.vaultNeed) {
        case .savedKey: return .saved
        case .making, .allow: break
        default: return .unsaved
        }
        recovery.leaving = true
        return await withCheckedContinuation { continuation in
            uninstall = continuation
            open(.asked)
        }
    }

    private func leave(_ step: Uninstall.KeyStep) {
        guard let waiting = uninstall else { return }
        uninstall = nil
        recovery.leaving = false
        waiting.resume(returning: step)
        if step == .saved { window?.close() }
    }

    func open(_ door: RecoveryKey.Door) {
        present()
        Task { await recovery.open(door) }
    }

    private func present() {
        let window = window ?? made()
        if onScreen { AppActivation.front(window, in: NSApp) }
    }

    func close() {
        window?.performClose(nil)
    }

    private func made() -> NSWindow {
        let view = RecoveryKeyView(recovery: recovery, needs: needs, close: { [weak self] in self?.close() },
                                   learnMore: { [weak self] in self?.browse(RecoveryKey.learnMore) })
        let hosting = NSHostingController(rootView: view.cockpitPlatform(.mac))
        hosting.sizingOptions = [.preferredContentSize]
        let window = NSWindow(contentViewController: hosting)
        window.styleMask = [.titled, .closable]
        window.title = Self.title
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.backgroundColor = NSColor(Cockpit.Color.surface)
        window.delegate = self
        window.center()
        self.window = window
        return window
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard !recovery.confirming else { return false }
        guard recovery.asksBeforeClosing else { return true }
        Task { _ = await closeOnce(sender, sending: true) }
        return false
    }

    func asksBeforeQuitting(_ source: QuitSource) -> Bool {
        source != .controlShutdown && recovery.asksBeforeClosing && window != nil
    }

    func beforeQuit(_ source: QuitSource) async -> Bool {
        if recovery.confirming { _ = await recovery.$confirming.values.first { !$0 } }
        guard asksBeforeQuitting(source), let window else { return true }
        if onScreen { AppActivation.front(window, in: NSApp) }
        return await closeOnce(window, sending: source != .system)
    }

    private func closeOnce(_ window: NSWindow, sending: Bool) async -> Bool {
        if let closing { return await closing.value }
        let asked = Task {
            let closed = await askToClose(window, sending: sending)
            closing = nil
            return closed
        }
        closing = asked
        return await asked.value
    }

    private func askToClose(_ window: NSWindow, sending: Bool) async -> Bool {
        guard await ask(window) == .discard, !recovery.confirming, let discarded = await recovery.discard(sending: sending) else { return false }
        if discarded == .owed, sending { await tell(window, recovery.owedWords) }
        window.close()
        return true
    }

    func windowWillClose(_ notification: Notification) {
        leave(.cancelled)
        recovery.forget()
        window = nil
    }

    private static func askClosing(over window: NSWindow) async -> Closing {
        let alert = NSAlert()
        alert.messageText = unsavedClose
        alert.informativeText = unsavedCloseDetail
        alert.addButton(withTitle: "Go back")
        alert.addButton(withTitle: "Discard this key").hasDestructiveAction = true
        return await alert.beginSheetModal(for: window) == .alertSecondButtonReturn ? .discard : .goBack
    }

    private static func tell(_ words: String, over window: NSWindow) async {
        let alert = NSAlert()
        alert.messageText = notAnswering
        alert.informativeText = words
        alert.addButton(withTitle: "OK")
        _ = await alert.beginSheetModal(for: window)
    }
}

struct RecoveryKeyView: View {
    static let width: CGFloat = 560

    static func savedKeyWords(keyed: Bool) -> String {
        (keyed ? "This Mac's key and this one are the only two ways into Lifestream: make a new key if this one is lost."
               : "Make a new key if this one is lost.") + " Your old key keeps working until you save the new one."
    }
    static let keyedLost = "Lifestream opens only with this Mac's key or your recovery key. Type your recovery key in Lifestream's window to unlock it. Without either key, nobody can open it, not you and not us."

    @ObservedObject var recovery: RecoveryKey
    @ObservedObject var needs: NeedsModel
    let close: () -> Void
    let learnMore: () -> Void
    @State private var typed = ""

    var body: some View {
        VStack(spacing: 0) {
            if recovery.leaving {
                Callout(UninstallWords.leaving, detail: UninstallWords.leavingDetail, action: "Cancel uninstall", perform: close)
                    .padding([.horizontal, .top], Cockpit.Space.s6)
                    .frame(width: Self.width)
            }
            face
        }
        .groundColor(Cockpit.Color.surface)
    }

    @ViewBuilder private var face: some View {
        switch recovery.face {
        case .reading:
            KeyFace {
                ProgressView().controlSize(.small)
            } acts: {}
        case .making:
            KeyFace {
                if let refusal = recovery.refusal {
                    InPlaceLine(refusal.words) { Task { await recovery.make() } }
                } else {
                    HStack(spacing: Cockpit.Space.s2) {
                        ProgressView().controlSize(.small)
                        Text("Making your recovery key…").quiet(.body)
                    }
                }
            } acts: {}
        case .shown:
            if let shown = recovery.shown { shownFace(shown) }
        case .savedKey(let name):
            KeyFace {
                Text(name.map { "Your recovery key is saved: \($0.inLine)." } ?? "Your recovery key is saved.").quiet(.body)
                Text(Self.savedKeyWords(keyed: recovery.keyed)).quiet(.body)
                Button("Check your recovery key…") { recovery.checking() }.buttonStyle(.link)
                HStack(spacing: Cockpit.Space.s1) {
                    Text("If someone else may have your key, a new key is not enough.").quiet(.body)
                    Button("Learn more", action: learnMore).buttonStyle(.link)
                }
                refused
            } acts: {
                Button("Done", action: close).buttonStyle(.cockpit(.secondary)).keyboardShortcut(.cancelAction)
                Button("Make a new key") { Task { await recovery.make() } }.buttonStyle(.cockpit(.primary))
                    .disabled(recovery.working)
            }
        case .saved(let name, let replaced):
            KeyFace {
                Text("\(name.title) is saved.").cockpit(.body).foregroundStyle(Cockpit.Color.text)
                if let replaced {
                    Text("\(replaced.title) no longer opens \(recovery.opens). A copy of Lifestream's folder from before today still opens only with it: keep it with any such copy.")
                        .quiet(.body)
                }
            } acts: {
                Button("Done", action: close).buttonStyle(.cockpit(.primary)).keyboardShortcut(.defaultAction)
            }
        case .allow:
            KeyFace {
                Text(recovery.keyed ? "Lifestream is locked on this Mac. Allow it to open, then save your recovery key."
                                    : "Your passwords are locked on this Mac. Allow Lifestream to open them, then save your recovery key.").quiet(.body)
                if let refusal = needs.refusals[Need.allow.id] { InPlaceLine(refusal) }
            } acts: {
                Button("Not now", action: close).buttonStyle(.cockpit(.plain)).keyboardShortcut(.cancelAction)
                Button("Allow") { Task { await recovery.allow() } }.buttonStyle(.cockpit(.primary)).keyboardShortcut(.defaultAction)
                    .disabled(needs.working.contains(Need.allow.id))
            }
        case .lost where recovery.keyed:
            KeyFace("Lifestream is locked") {
                Text(Self.keyedLost).quiet(.body)
            } acts: {
                Button("Done", action: close).buttonStyle(.cockpit(.primary)).keyboardShortcut(.defaultAction)
            }
        case .lost:
            KeyFace("Start a new vault?") {
                Text("Your saved passwords can't be opened without your recovery key, so they are deleted. Every connector that needs a password asks for it again. The rest of Lifestream is kept.")
                    .quiet(.body)
                if !recovery.elsewhere.isEmpty {
                    Text("Your passwords may still open on \(recovery.elsewhere.joined(separator: " or ")): open Lifestream there instead to keep them.")
                        .quiet(.body)
                }
                refused
            } acts: {
                Button("Cancel", action: close).buttonStyle(.cockpit(.plain)).keyboardShortcut(.cancelAction)
                Button("Start a new vault") { Task { await recovery.startNewVault() } }
                    .buttonStyle(.cockpit(.primary, tone: .warning, busy: recovery.working))
                    .disabled(recovery.working)
            }
        case .check:
            KeyFace("Check your recovery key") {
                Text("Type your recovery key. Lifestream says whether it opens \(recovery.opens), and changes nothing.").quiet(.body)
                Field("Recovery key", text: $typed, secure: true)
                    .disabled(recovery.working)
                if let checked = recovery.checked { Text(recovery.checkedLine(checked)).quiet(.body) }
                refused
            } acts: {
                Button("Done", action: close).buttonStyle(.cockpit(.secondary)).keyboardShortcut(.cancelAction)
                Button("Check") { Task { await recovery.check(typed) } }
                    .buttonStyle(.cockpit(.primary, busy: recovery.working)).keyboardShortcut(.defaultAction)
                    .disabled(typed.isEmpty || recovery.working)
            }
            .onDisappear { typed = "" }
        case .noHome:
            KeyFace {
                Text("Lifestream isn't answering, so it can't make a key now.").quiet(.body)
            } acts: {
                Button("Try again") { Task { await recovery.open(.asked) } }.buttonStyle(.cockpit(.primary)).keyboardShortcut(.defaultAction)
            }
        }
    }

    static func lines(_ key: String) -> String {
        let groups = RecoveryKeyFile.grouped(key).split(separator: " ")
        let half = (groups.count + 1) / 2
        return [groups.prefix(half), groups.dropFirst(half)].map { $0.joined(separator: " ") }.joined(separator: "\n")
    }

    @ViewBuilder private var refused: some View {
        if let refusal = recovery.refusal { InPlaceLine(refusal.words) }
    }

    private func shownFace(_ shown: RecoveryKey.Shown) -> some View {
        KeyFace(shown.name.title, line: shown.name.madeLine) {
            keyText(shown.key)
            Text("It opens \(recovery.opens) on another Mac, or on this Mac if its Keychain loses Lifestream's key. Lifestream shows it once. Keep it away from this Mac: in your password manager, or printed.")
                .quiet(.body)
            if let said = recovery.said { Text(said).quiet(.body) }
            refused
        } acts: {
            keyActs
        }
    }

    private func keyText(_ key: String) -> some View {
        Text(Self.lines(key))
            .font(.system(size: 15, weight: .medium, design: .monospaced))
            .foregroundStyle(Cockpit.Color.text)
            .textSelection(.disabled)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, Cockpit.Space.s2)
    }

    private var keyActs: some View {
        VStack(alignment: .trailing, spacing: Cockpit.Space.s2) {
            HStack(spacing: Cockpit.Space.s2) {
                Button("Save as file…") { Task { await recovery.save() } }.buttonStyle(.cockpit(.secondary))
                Button("Copy") { recovery.copy() }.buttonStyle(.cockpit(.secondary))
                Button("I've saved it") { Task { await recovery.confirm() } }
                    .buttonStyle(.cockpit(.primary, busy: recovery.working)).keyboardShortcut(.defaultAction)
                    .disabled(recovery.used == nil || recovery.working)
            }
            if recovery.used == nil { Text(RecoveryKey.toGoOn).quiet(.footnote) }
        }
    }
}

private struct KeyFace<Content: View, Acts: View>: View {
    let heading: String?
    let line: String?
    let content: Content
    let acts: Acts

    init(_ heading: String? = nil, line: String? = nil, @ViewBuilder content: () -> Content, @ViewBuilder acts: () -> Acts) {
        self.heading = heading
        self.line = line
        self.content = content()
        self.acts = acts()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                if heading != nil || line != nil {
                    VStack(alignment: .leading, spacing: 2) {
                        if let heading {
                            Text(heading).cockpit(.title2).foregroundStyle(Cockpit.Color.text).accessibilityAddTraits(.isHeader)
                        }
                        if let line { Text(line).quiet() }
                    }
                }
                content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Cockpit.Space.s6)
            if Acts.self != EmptyView.self {
                HStack {
                    Spacer(minLength: Cockpit.Space.s2)
                    acts
                }
                .padding(.horizontal, Cockpit.Space.s6)
                .padding(.vertical, 14)
                .overlay(alignment: .top) { Rectangle().fill(Cockpit.Color.rule).frame(height: Cockpit.Stroke.border) }
            }
        }
        .frame(width: RecoveryKeyView.width, alignment: .leading)
        .groundColor(Cockpit.Color.surface)
    }
}
