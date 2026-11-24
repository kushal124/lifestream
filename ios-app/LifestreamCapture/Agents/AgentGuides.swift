import Cockpit
import Combine
import HomeLink
import LifestreamCaptureCore
import SwiftUI
import UIKit

enum AgentGuideState {
    static let nameSlot = "{name}"
    static let hostSlot = "{host}"

    enum Mark: String, Equatable { case here, later, done, plain }

    enum Address: String, Equatable {
        case checking, fix, check
        case turnOn = "turn-on"
    }

    enum Head: String, Equatable { case need, short, done }

    enum Show: String, Equatable {
        case tailscale, add, message, line, copied, waiting, arrived, edit, finishing, denied, connected, sees, rows, name, elsewhere
        case oneLine = "one-line"
        case seesDone = "sees-done"
    }

    enum Line: String, Equatable {
        case addrOn = "addr.on"
        case yesHint = "yes.hint"
        case yesWrong = "yes.wrong"
        case yesDenied = "yes.denied"
        case yesUnfinished = "yes.unfinished"
        case yesOut = "yes.out"
        case connectedLine = "connected.line"
        case doneAsk = "done.ask"
        case giveWarn = "give.warn"
        case giveOnce = "give.once"
        case giveUnknown = "give.unknown"
    }

    enum Foot: String, Equatable {
        case deny, done, open, make, making
        case pickLine = "pick_line"
        case startAgain = "start-again"
        case makeWaits = "make-waits"
    }

    struct SignInDialog: Equatable {
        enum Outcome: String, Equatable { case wrong, denied, finishing }

        var copied = false
        var setup = false
        var returned = false
        var shown: String?
        var outcome: Outcome?
        var editing = false
    }

    struct KeyDialog: Equatable {
        enum Made: String, Equatable { case refused, unknown, made }

        var linked = false
        var named: String?
        var setup = false
        var making = false
        var made: Made?
        var done = false
    }

    struct Waiting: Equatable {
        let id: String
        let app: String?
        let host: String?
        let atMs: Int64

        init(id: String, app: String?, host: String?, atMs: Int64) {
            self.id = id
            self.app = app
            self.host = host
            self.atMs = atMs
        }

        init(_ signIn: HomeLink.SignIn) {
            self.init(id: signIn.id, app: signIn.app, host: signIn.host, atMs: signIn.atMs)
        }
    }

    struct Read: Equatable {
        let id: String
        let state: HomeLink.SignInRead.State
        let reader: String?
    }

    struct Yes: Equatable {
        let sees: String
        let other: String
        let finishing: String
        let reads: String
    }

    struct Drawn: Equatable {
        var address: Address?
        var head: Head
        var marks: [Mark]
        var shows: [Show]
        var lines: [Line]
        var signin: String?
        var other: String?
        var foot: [Foot]
    }

    static func address(_ address: HomeLink.AgentAddress?, setup: Bool) -> Address? {
        switch address {
        case nil: .checking
        case .fix(_, let act)?: act == nil ? .check : .fix
        case .off? where setup: .turnOn
        default: nil
        }
    }

    static func setup(_ guide: HomeLink.Pages.Guide, _ showed: Bool, address: HomeLink.AgentAddress?) -> Bool {
        guard guide.address != nil else { return false }
        if case .fix? = address { return true }
        return showed
    }

    private static func on(_ address: HomeLink.AgentAddress?) -> Bool {
        if case .on? = address { true } else { false }
    }

    private static func tailscale(_ drawn: Drawn, on: Bool) -> Drawn {
        var drawn = drawn
        drawn.marks = [on ? .done : .here] + drawn.marks.map { on ? $0 : .later }
        drawn.shows = [.tailscale] + drawn.shows.map { on ? $0 : .line }
        if !on {
            drawn.head = .need
            drawn.lines = []
            drawn.signin = nil
            drawn.other = nil
        }
        return drawn
    }

    static func signIn(_ guide: HomeLink.Pages.Guide, _ dialog: SignInDialog, address: HomeLink.AgentAddress?, waiting: [Waiting],
                       read: Read?) -> Drawn {
        let app = guide.app.rawValue
        let newest: (Waiting, Waiting) -> Bool = { $0.atMs > $1.atMs }
        let mine = waiting.filter { $0.app == app && $0.id != read?.id }.sorted(by: newest)
        let kept = mine.first { $0.id == dialog.shown } ?? mine.first
        let said: [Line] = read?.state == .wrong ? [.yesWrong] : read?.state == .denied ? [.yesDenied] : []
        let phase: Show = if read?.reader != nil { .connected }
            else if read?.state == .approved { .finishing }
            else if kept != nil { dialog.editing ? .edit : .arrived }
            else if read?.state == .denied { .denied }
            else if read != nil || dialog.copied { .waiting }
            else { .line }
        let gone: [Line] = read?.state == .gone && phase == .waiting ? [dialog.outcome == .finishing ? .yesUnfinished : .yesOut] : []
        let whole = phase == .line || (phase == .waiting && read == nil)
        let first: Show = if case .message? = guide.steps.first { .message } else { .add }
        let shownFirst: Show = !whole ? .oneLine : dialog.copied ? .copied : first
        let markFirst: Mark = phase == .connected ? .done : whole ? .here : dialog.copied ? .done : .plain
        let on = Self.on(address)
        let setup = Self.setup(guide, dialog.setup, address: address)
        let lines: [Line] = (shownFirst != .oneLine && on && (dialog.copied || setup) ? [.addrOn] : [])
            + (phase == .connected || phase == .finishing ? [] : said)
            + gone
            + (phase == .waiting && dialog.returned && read == nil ? [.yesHint] : [])
            + (phase == .connected ? [.connectedLine] + (guide.done.ask == nil ? [] : [.doneAsk]) : [])
        let foot: [Foot] = switch phase {
        case .arrived: [.pickLine, .deny]
        case .edit: [.done]
        case .denied: [.startAgain]
        case .connected: (guide.done.open == nil ? [] : [.open]) + [.done]
        default: []
        }
        let drawn = Drawn(address: Self.address(address, setup: setup),
                          head: phase == .connected ? .done : [.arrived, .edit, .finishing, .denied].contains(phase) ? .short : .need,
                          marks: [markFirst, phase == .connected ? .done : phase == .line ? .later : .here],
                          shows: [shownFirst, phase],
                          lines: lines,
                          signin: phase == .arrived || phase == .edit ? kept?.id : nil,
                          other: phase == .waiting ? waiting.filter { $0.app != app }.sorted(by: newest).first?.id : nil,
                          foot: foot)
        guard setup else { return drawn }
        var shown = Self.tailscale(drawn, on: on)
        if !on { shown.foot = [] }
        return shown
    }

    static func key(_ guide: HomeLink.Pages.Guide, _ dialog: KeyDialog, address: HomeLink.AgentAddress?) -> Drawn {
        let steps = guide.steps
        if case .elsewhere? = steps.first {
            return Drawn(address: nil, head: .need, marks: [.here], shows: [.elsewhere], lines: [], foot: [])
        }
        let before = steps.first { step in
            switch step {
            case .message, .name: true
            default: false
            }
        }
        let ready: Bool = switch before {
        case nil: true
        case .message?: dialog.linked
        default: !(dialog.named ?? "").isEmpty
        }
        let made = dialog.made == .made
        let done = made && dialog.done
        let warns = steps.contains { if case .give(_, _, _, _, let warn?, _, _) = $0 { warn.isEmpty == false } else { false } }
        let drawn: [(Mark, Show)] = steps.map { step in
            switch step {
            case .message: (ready ? .done : .here, .message)
            case .name: (ready ? .done : .here, .name)
            case .sees: made ? (.done, .seesDone) : (ready ? .here : .later, ready ? .sees : .line)
            default: made ? (done ? .done : .here, done ? .oneLine : .rows) : (.later, .line)
            }
        }
        let setup = Self.setup(guide, dialog.setup, address: address)
        let mark = guide.address == nil ? nil : Self.address(address, setup: setup)
        let foot: [Foot] = if made { done ? (guide.done.open == nil ? [] : [.open]) + [.done] : [.done] }
            else if !ready { if case .message? = before { [] } else { [.makeWaits] } }
            else if dialog.making { [.making] }
            else if mark != nil { [.makeWaits] }
            else { [.make] }
        let lines: [Line] = dialog.made == .unknown ? [.giveUnknown]
            : done ? [.connectedLine] + (guide.done.ask == nil ? [] : [.doneAsk])
            : made ? (warns ? [.giveWarn] : []) + [.giveOnce] : []
        let shown = Drawn(address: mark, head: done ? .done : .need, marks: drawn.map { done ? .done : $0.0 }, shows: drawn.map(\.1),
                          lines: lines, signin: nil, other: nil, foot: foot)
        return setup ? Self.tailscale(shown, on: Self.on(address)) : shown
    }

    static func yes(_ guide: HomeLink.Pages.Guide) -> Yes? {
        guide.steps.lazy.compactMap { step -> Yes? in
            guard case .yes(_, _, _, _, let sees, let other, _, let finishing, _, _, _, let reads) = step else { return nil }
            return Yes(sees: sees, other: other, finishing: finishing, reads: reads)
        }.first
    }

    static func words(_ line: Line, in guide: HomeLink.Pages.Guide) -> String? {
        guide.steps.lazy.compactMap { step -> String? in
            switch (line, step) {
            case (.yesHint, .yes(_, _, _, let hint, _, _, _, _, _, _, _, _)): hint
            case (.yesWrong, .yes(_, _, _, _, _, _, let wrong, _, _, _, _, _)): wrong
            case (.yesUnfinished, .yes(_, _, _, _, _, _, _, _, let unfinished, _, _, _)): unfinished
            case (.yesOut, .yes(_, _, _, _, _, _, _, _, _, let out, _, _)): out
            case (.yesDenied, .yes(_, _, _, _, _, _, _, _, _, _, let denied, _)): denied
            case (.giveWarn, .give(_, _, _, _, let warn, _, _)): warn
            case (.giveOnce, .give(_, _, _, _, _, let once, _)): once
            case (.giveUnknown, .give(_, _, _, _, _, _, let unknown)): unknown
            default: nil
            }
        }.first
    }

    static func loopback(_ guide: HomeLink.Pages.Guide) -> Bool {
        guide.steps.contains { if case .name = $0 { true } else { false } }
    }

    static func url(_ link: HomeLink.Pages.GuideLink?) -> URL? {
        switch link {
        case .web(_, let url)?: URL(string: url)
        case .messages?: URL(string: "sms:")
        default: nil
        }
    }

    static func label(_ link: HomeLink.Pages.GuideLink?) -> String? {
        switch link {
        case .web(let label, _)?, .messages(let label)?: label
        default: nil
        }
    }
}

@MainActor
final class AgentGuideModel: ObservableObject {
    struct Step: Identifiable {
        let id: Int
        let step: HomeLink.Pages.GuideStep?
        let mark: AgentGuideState.Mark
        let show: AgentGuideState.Show
    }

    let guide: HomeLink.Pages.Guide
    @Published private(set) var address: HomeLink.AgentAddress? {
        didSet {
            if AgentGuideState.setup(guide, false, address: address) {
                dialog.setup = true
                keyDialog.setup = true
            }
            roundAddress()
        }
    }
    @Published private(set) var addressFailed: String?
    @Published private(set) var dialog = AgentGuideState.SignInDialog()
    @Published private(set) var keyDialog = AgentGuideState.KeyDialog()
    @Published private(set) var read: AgentGuideState.Read?
    @Published private(set) var connectedLine: String?
    @Published private(set) var listed: [HomeLink.SignIn] = []
    @Published private(set) var sending: AgentRequestCard.Pick?
    @Published private(set) var failed: String?
    @Published private(set) var editor: AccessEditorModel?
    @Published private(set) var kept: [String: HomeLink.AccessDraft] = [:]
    @Published private(set) var draft: HomeLink.AccessDraft?
    @Published private(set) var made: HomeLink.MadeKey?
    private let sees: HomeLink.GuideSees?
    private let link: HomeLink
    private let asks: AgentAsks?
    private let prove: () async -> Bool
    private let rest: () async -> Void
    @Published private var turning: Task<HomeLink.AgentAddress?, Never>?
    private var reading: Set<String> = []
    private var watching: AnyCancellable?
    private var live = false
    private var rounding: Task<Void, Never>?

    init(guide: HomeLink.Pages.Guide, sees: HomeLink.GuideSees?, link: HomeLink, asks: AgentAsks?,
         prove: @escaping () async -> Bool = { await LifeLock.shared.prove() },
         rest: @escaping () async -> Void = { try? await Task.sleep(for: AgentAsks.every) }) {
        self.guide = guide
        self.sees = sees
        self.link = link
        self.asks = asks
        self.prove = prove
        self.rest = rest
    }

    var signs: Bool { guide.how == .signIn }

    var drawn: AgentGuideState.Drawn {
        signs ? AgentGuideState.signIn(guide, dialog, address: address, waiting: listed.map(AgentGuideState.Waiting.init), read: read)
            : AgentGuideState.key(guide, keyDialog, address: address)
    }

    var steps: [Step] {
        let drawn = drawn
        let own = guide.steps.map(Optional.some)
        return (drawn.shows.first == .tailscale ? [nil] + own : own).prefix(drawn.shows.count).enumerated().map { index, step in
            Step(id: index, step: step, mark: drawn.marks[index], show: drawn.shows[index])
        }
    }

    var turningOn: Bool { turning != nil }

    var shownSignIn: HomeLink.SignIn? {
        drawn.signin.flatMap { id in listed.first { $0.id == id } }
    }

    var otherSignIn: HomeLink.SignIn? {
        drawn.other.flatMap { id in listed.first { $0.id == id } }
    }

    var head: (title: String, line: String?) {
        switch drawn.head {
        case .need: (filled(guide.head), guide.need)
        case .short: (filled(guide.head), nil)
        case .done: (filled(guide.done.title), connectedLine)
        }
    }

    var seen: HomeLink.AccessView? { draft?.view ?? sees?.view }

    var yes: AgentGuideState.Yes? { AgentGuideState.yes(guide) }

    func words(_ line: AgentGuideState.Line) -> String? {
        AgentGuideState.words(line, in: guide).map(filled)
    }

    var keyApp: HomeLink.KeyApp? { HomeLink.KeyApp(rawValue: guide.app.rawValue) }

    func filled(_ words: String) -> String {
        words.replacingOccurrences(of: AgentGuideState.nameSlot, with: keyDialog.named.flatMap { $0.isEmpty ? nil : $0 } ?? guide.name)
    }

    func text(_ value: HomeLink.Pages.GuideValue) -> String? {
        guard value.address else { return value.text }
        return address?.url.map { value.text + $0 }
    }

    func start() async {
        live = true
        if signs, let asks {
            asks.guide(guide.app.rawValue)
            watching = asks.$signIns.sink { [weak self] signIns in
                MainActor.assumeIsolated { self?.heard(signIns) }
            }
        }
        if guide.address != nil { await readAddress() }
    }

    func stop() {
        live = false
        rounding?.cancel()
        rounding = nil
        watching = nil
        asks?.guide(nil)
    }

    func cameToFront() async {
        dialog.returned = dialog.copied
        if guide.address != nil { await readAddress() }
    }

    var roundsAddress: Bool { rounding != nil }

    private var settingUp: Bool {
        if case .on? = address { return false }
        return AgentGuideState.setup(guide, dialog.setup || keyDialog.setup, address: address)
    }

    private func roundAddress() {
        guard live, rounding == nil, settingUp else { return }
        rounding = Task { [weak self] in
            while let model = self, model.live, model.settingUp {
                await model.rest()
                guard !Task.isCancelled, model.live, model.settingUp else { break }
                if let turning = model.turning { _ = await turning.value } else { await model.readAddress() }
            }
            if !Task.isCancelled { self?.rounding = nil }
        }
    }

    func readAddress() async {
        do {
            address = try await link.address()
            addressFailed = nil
        } catch {
            if address == nil { addressFailed = Self.said(error) }
        }
    }

    @discardableResult
    func turnOn() async -> HomeLink.AgentAddress? {
        if let turning { return await turning.value }
        let link = link
        let task = Task<HomeLink.AgentAddress?, Never> { try? await link.turnAddressOn() }
        turning = task
        let answered = await task.value
        turning = nil
        if let answered {
            address = answered
            addressFailed = nil
        } else {
            await readAddress()
        }
        return address
    }

    func copied(_ value: HomeLink.Pages.GuideValue) {
        guard value.address else { return }
        dialog.copied = true
        dialog.returned = false
        Task { await turnOn() }
    }

    func act(_ fix: HomeLink.AgentAddress.Fix) async -> URL? {
        switch fix.to {
        case .turnOn:
            guard case .fix(_, let act?)? = await turnOn(), act.to == .web else { return nil }
            return act.url.flatMap(URL.init(string:))
        case .web:
            return fix.url.flatMap(URL.init(string:))
        case .tailscale:
            await readAddress()
            return nil
        }
    }

    func heard(_ signIns: [HomeLink.SignIn]) {
        if let shown = dialog.shown, !signIns.contains(where: { $0.id == shown }), !settled(shown) {
            listed = signIns + listed.filter { $0.id == shown }
            readSignIn(shown)
            return
        }
        listed = signIns
        if let id = drawn.signin, dialog.shown != id { dialog.shown = id }
    }

    private func settled(_ id: String) -> Bool {
        guard let read, read.id == id else { return false }
        return read.state != .waiting && !(read.state == .approved && read.reader == nil)
    }

    func pick(_ pick: AgentRequestCard.Pick) {
        guard sending == nil, let signIn = shownSignIn else { return }
        let answer: HomeLink.AnswerRequest = switch pick {
        case .number(let number): .number(signIn.id, number, access: kept[signIn.id]?.access)
        case .deny: .deny(signIn.id)
        }
        sending = pick
        failed = nil
        Task {
            defer { sending = nil }
            if answer.allows, !(await prove()) {
                failed = AgentAsks.unproved
                return
            }
            do {
                let reply = try await link.answer(answer)
                answered(signIn.id)
                switch reply.state {
                case .approved: land(signIn.id, .approved, reader: reply.reader, line: reply.connected?.line)
                case .wrong: land(signIn.id, .wrong, reader: nil, line: nil)
                case .denied: land(signIn.id, .denied, reader: nil, line: nil)
                default: readSignIn(signIn.id)
                }
            } catch {
                switch AgentAsks.failed(error) {
                case .gone:
                    answered(signIn.id)
                    land(signIn.id, .gone, reader: nil, line: nil)
                case .said(let words), .erased(let words):
                    failed = words
                case .unsure:
                    failed = AgentAsks.unsure
                    readSignIn(signIn.id)
                }
            }
        }
    }

    func startAgain() {
        read = nil
        failed = nil
        dialog.outcome = nil
        dialog.shown = nil
    }

    func edit() {
        guard let signIn = shownSignIn else { return }
        open(AccessEditorModel(link: link, name: signIn.name, purpose: .signIn, target: .request(signIn.id),
                               access: kept[signIn.id]?.access ?? signIn.access, expect: nil))
    }

    func editKey() {
        guard let app = keyApp, let access = draft?.access ?? sees?.access else { return }
        open(AccessEditorModel(link: link, name: filled(guide.name), purpose: .signIn, target: .key(app), access: access, expect: nil))
    }

    func editDone() {
        guard let editor else { return }
        if let edited = editor.editing.draft {
            switch editor.editing.target {
            case .request(let id): kept[id] = edited
            case .key: draft = edited
            case .reader: break
            }
        }
        editBack()
    }

    func editBack() {
        editor = nil
        dialog.editing = false
    }

    func linked() {
        keyDialog.linked = true
    }

    func named(_ name: String) {
        keyDialog.named = name
    }

    func make() {
        guard !keyDialog.making, let app = keyApp, let access = draft?.access ?? sees?.access else { return }
        keyDialog.making = true
        failed = nil
        let name = AgentGuideState.loopback(guide) ? keyDialog.named : nil
        Task {
            defer { keyDialog.making = false }
            guard await prove() else {
                failed = AgentAsks.unproved
                return
            }
            if !AgentGuideState.loopback(guide) {
                guard case .on? = await turnOn() else {
                    keyDialog.made = .refused
                    return
                }
            }
            do {
                let key = try await link.makeKey(app, name: name, access: access)
                made = key
                connectedLine = key.connected.line
                keyDialog.made = .made
            } catch LinkFailure.refused(409, "ADDRESS_NOT_READY", _) {
                keyDialog.made = .refused
                await readAddress()
            } catch {
                switch AgentAsks.failed(error) {
                case .unsure: keyDialog.made = .unknown
                case .said(let words), .erased(let words), .gone(let words): failed = words
                }
            }
        }
    }

    func finish() -> Bool {
        guard signs == false, keyDialog.made == .made, !keyDialog.done, guide.done.ask != nil else { return true }
        keyDialog.done = true
        return false
    }

    private func open(_ editor: AccessEditorModel) {
        self.editor = editor
        dialog.editing = true
        editor.open()
    }

    private func answered(_ id: String) {
        asks?.answeredInGuide(id)
        listed.removeAll { $0.id == id }
    }

    private func readSignIn(_ id: String) {
        guard reading.insert(id).inserted else { return }
        Task {
            defer { reading.remove(id) }
            do {
                let read = try await link.signIn(id)
                land(id, read.state, reader: read.reader, line: read.connected?.line)
            } catch {
                if case .gone = AgentAsks.failed(error) { land(id, .gone, reader: nil, line: nil) }
            }
        }
    }

    private func land(_ id: String, _ state: HomeLink.SignInRead.State, reader: String?, line: String?) {
        guard state != .waiting else { return }
        let finishing = dialog.outcome == .finishing && dialog.shown == id
        dialog.outcome = switch state {
        case .approved where reader == nil: .finishing
        case .gone where finishing: .finishing
        case .wrong: .wrong
        case .denied: .denied
        default: nil
        }
        dialog.shown = id
        read = AgentGuideState.Read(id: id, state: state, reader: reader)
        if let line { connectedLine = line }
    }

    private static func said(_ error: Error) -> String {
        switch AgentAsks.failed(error) {
        case .said(let words), .gone(let words), .erased(let words): words
        case .unsure: AgentAsks.unsure
        }
    }
}

struct GuideRows: View {
    let guides: HomeLink.AgentGuides
    @State private var shown: Shown?
    @Environment(\.openConnectors) private var open

    struct Shown: Identifiable {
        let guide: HomeLink.Pages.Guide

        var id: String { guide.app.rawValue }
    }

    var body: some View {
        let apps = guides.apps
        ForEach(Array(apps.enumerated()), id: \.offset) { index, guide in
            ListRow(guide.name, meta: guide.line, leading: .tile(AgentsStore.mark(guide.mark)), chevron: true, separator: index < apps.count - 1,
                    action: { opened(guide) }) {
                if guide.connected != nil { RowEnd(.place(AgentsWords.connected)) }
            }
            .accessibilityIdentifier("agents.guide.\(guide.app.rawValue)")
        }
        .sheet(item: $shown, onDismiss: { Task { await AgentsStore.shared.readAll() } }) { shown in
            AgentGuideSheet(guide: shown.guide, sees: guides.sees[shown.guide.app])
        }
    }

    private func opened(_ guide: HomeLink.Pages.Guide) {
        if let reader = guide.connected {
            open(.agent(reader))
        } else {
            shown = Shown(guide: guide)
        }
    }
}

struct AgentGuideSheet: View {
    @StateObject private var model: AgentGuideModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var phase

    init(guide: HomeLink.Pages.Guide, sees: HomeLink.GuideSees?) {
        _model = StateObject(wrappedValue: AgentGuideModel(guide: guide, sees: sees, link: AppRuntime.shared.shipping.link,
                                                           asks: AppRuntime.shared.agents))
    }

    var body: some View {
        let drawn = model.drawn
        let head = model.head
        PageDrawer(head.title, icon: AgentsStore.mark(model.guide.mark), tiled: true, line: head.line) {
            GuideAddress(model: model, mark: drawn.address)
            ForEach(model.steps) { step in
                if let own = step.step {
                    GuideStepView(model: model, step: step, own: own, number: step.id + 1, lines: drawn.lines)
                } else {
                    GuideTailscale(model: model, number: step.id + 1, mark: step.mark, address: drawn.address) { url in openURL(url) }
                }
            }
            if drawn.lines.contains(.doneAsk), let ask = model.guide.done.ask {
                SheetPart(ask.title, line: ask.line) {
                    GuideValueRow(label: nil, text: ask.question, identifier: "guide.question")
                }
            }
        } foot: {
            GuideFoot(model: model, foot: drawn.foot) { dismiss() }
        }
        .drawerRest(.large)
        .task { await model.start() }
        .onDisappear { model.stop() }
        .onChange(of: phase) { _, now in
            if now == .active { Task { await model.cameToFront() } }
        }
        .sheet(item: Binding(get: { model.editor }, set: { if $0 == nil { model.editBack() } })) { editor in
            AccessEditorSheet(model: editor, answering: false) { model.editBack() } finish: { model.editDone() }
                .modifier(UITestAppearanceOverride())
        }
        .accessibilityIdentifier("guide.\(model.guide.app.rawValue)")
    }
}

private struct GuideAddress: View {
    @ObservedObject var model: AgentGuideModel
    let mark: AgentGuideState.Address?

    var body: some View {
        if let failed = model.addressFailed, model.address == nil {
            InPlaceLine(failed, severity: .needs, act: GuideWords.check) { Task { await model.readAddress() } }
                .accessibilityIdentifier("guide.address")
        } else if mark == .checking {
            HStack(spacing: Cockpit.Space.s2) {
                Loading(size: .glyph).accessibilityHidden(true)
                Text(GuideWords.getting).cockpit(.subhead).foregroundStyle(Cockpit.Color.textSecondary)
            }
            .accessibilityIdentifier("guide.address")
        }
    }
}

private struct GuideTailscale: View {
    @ObservedObject var model: AgentGuideModel
    let number: Int
    let mark: AgentGuideState.Mark
    let address: AgentGuideState.Address?
    let opening: (URL) -> Void

    var body: some View {
        if let step = model.guide.address {
            Group {
                if mark == .done {
                    StepRow(number, done: true, title: step.title, separator: false)
                } else {
                    StepRow(number, title: step.title, words: step.line, separator: false) {
                        VStack(alignment: .leading, spacing: Cockpit.Space.s3) { fix(step) }
                    }
                }
            }
            .accessibilityIdentifier("guide.tailscale")
        }
    }

    @ViewBuilder private func fix(_ step: HomeLink.Pages.GuideAddress) -> some View {
        switch (address, model.address) {
        case (.fix?, .fix(let words, let act?)?):
            said(words)
            press(act.label) { if let url = await model.act(act) { opening(url) } }
        case (.check?, .fix(let words, _)?):
            said(words)
            press(GuideWords.check) { await model.readAddress() }
        case (.turnOn?, _):
            said(step.ready)
            press(step.on) { await model.turnOn() }
        default:
            EmptyView()
        }
    }

    private func said(_ words: String) -> some View {
        Text(words).cockpit(.subhead).foregroundStyle(Cockpit.Color.textSecondary).fixedSize(horizontal: false, vertical: true)
    }

    private func press(_ label: String, _ act: @escaping () async -> Void) -> some View {
        Button(label) { Task { await act() } }
            .buttonStyle(.cockpit(.secondary, size: .small, busy: model.turningOn))
            .disabled(model.turningOn)
            .accessibilityIdentifier("guide.tailscale.act")
    }
}

private struct GuideStepView: View {
    @ObservedObject var model: AgentGuideModel
    let step: AgentGuideModel.Step
    let own: HomeLink.Pages.GuideStep
    let number: Int
    let lines: [AgentGuideState.Line]
    @Environment(\.openURL) private var openURL

    var body: some View {
        if step.show == .arrived || step.show == .edit {
            arrived
        } else {
            Group { shown }.accessibilityIdentifier("guide.step.\(number)")
        }
    }

    @ViewBuilder private var shown: some View {
        switch step.show {
        case .oneLine, .seesDone:
            StepRow(number, done: step.mark == .done, title: model.filled(title), separator: false)
        case .line:
            StepRow(number, done: step.mark == .done, later: step.mark == .later, title: model.filled(title), words: dimmed, separator: false)
        case .add, .copied, .message:
            switch own {
            case .add(_, let place, let path, let values, let then, let open):
                StepRow(number, title: model.filled(title), separator: false) {
                    VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                        BoldLine([BoldRun(place + ": "), BoldRun(path.joined(separator: " \u{203A} ") + ".", bold: true)])
                        valueRows(values)
                        if let then { Text(then).cockpit(.subhead).foregroundStyle(Cockpit.Color.textSecondary) }
                        addressOn
                        opening(open, identifier: "guide.open.add")
                    }
                }
            case .message(_, let line, let value, let open, let next):
                if step.mark == .done {
                    StepRow(number, done: true, title: model.filled(title), separator: false)
                } else {
                    StepRow(number, title: model.filled(title), words: line, separator: false) {
                        VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                            valueRows([value])
                            addressOn
                            opening(open, identifier: "guide.open.message")
                            if let next, model.signs == false {
                                Button(next) { model.linked() }
                                    .buttonStyle(.cockpit(.secondary, size: .small))
                                    .accessibilityIdentifier("guide.linked")
                            }
                        }
                    }
                }
            default:
                EmptyView()
            }
        case .waiting, .finishing, .denied:
            StepRow(number, title: model.filled(title), separator: false) { yesWaiting }
        case .tailscale, .arrived, .edit:
            EmptyView()
        case .connected:
            StepRow(number, done: true, title: model.yes?.reads ?? model.filled(title), separator: false)
        case .sees:
            StepRow(number, title: model.filled(title), separator: false) {
                VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                    if let view = model.seen, case .sees(_, _, let sees) = own {
                        WillSee(title: sees, reads: AgentAsks.lines(view), change: { model.editKey() })
                    }
                    if lines.contains(.giveUnknown), let unknown = model.words(.giveUnknown) { InPlaceLine(unknown, severity: .needs) }
                    if let failed = model.failed { InPlaceLine(failed) }
                }
            }
        case .rows:
            if case .give(_, let place, let path, let then, _, _, _) = own {
                StepRow(number, done: step.mark == .done, title: model.filled(title), separator: false) {
                    VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                        if step.mark != .done {
                            if let place, !path.isEmpty {
                                BoldLine([BoldRun(place + ": "), BoldRun(path.joined(separator: " \u{203A} ") + ".", bold: true)])
                            }
                            ForEach(Array((model.made?.rows ?? []).enumerated()), id: \.offset) { index, row in
                                GuideValueRow(label: row.label, text: row.text, identifier: "guide.row.\(index)")
                            }
                            if let then { Text(then).cockpit(.subhead).foregroundStyle(Cockpit.Color.textSecondary) }
                            if lines.contains(.giveWarn), let warn = model.words(.giveWarn) { InPlaceLine(warn) }
                            if lines.contains(.giveOnce), let once = model.words(.giveOnce) {
                                Text(once).cockpit(.subhead).foregroundStyle(Cockpit.Color.textSecondary)
                            }
                        }
                    }
                }
            }
        case .name:
            if case .name(_, let placeholder) = own {
                if step.mark == .done {
                    StepRow(number, done: true, title: model.filled(title), separator: false)
                } else {
                    StepRow(number, title: model.filled(title), separator: false) {
                        Field(title, text: Binding(get: { model.keyDialog.named ?? "" }, set: { model.named($0) }), placeholder: placeholder)
                    }
                }
            }
        case .elsewhere:
            if case .elsewhere(let title, let line) = own {
                SheetPart(title) { SettingRow(model.filled(line), separator: false) }
            }
        }
    }

    @ViewBuilder private var addressOn: some View {
        if lines.contains(.addrOn), case .on(_, let line)? = model.address {
            InPlaceLine(line, severity: .done).accessibilityIdentifier("guide.address.on")
        }
    }

    private var title: String {
        switch own {
        case .add(let title, _, _, _, _, _), .message(let title, _, _, _, _), .yes(let title, _, _, _, _, _, _, _, _, _, _, _), .name(let title, _),
             .sees(let title, _, _), .give(let title, _, _, _, _, _, _), .elsewhere(let title, _): title
        case .unknown: ""
        }
    }

    private var dimmed: String? {
        if case .yes(_, let line, _, _, _, _, _, _, _, _, _, _) = own { model.filled(line) } else { nil }
    }

    @ViewBuilder private func valueRows(_ values: [HomeLink.Pages.GuideValue]) -> some View {
        ForEach(Array(values.enumerated()), id: \.offset) { index, value in
            GuideValueRow(label: value.label, text: model.text(value), identifier: "guide.value.\(index)",
                          shares: value.address) { model.copied(value) }
        }
    }

    @ViewBuilder private func opening(_ link: HomeLink.Pages.GuideLink?, identifier: String) -> some View {
        if let url = AgentGuideState.url(link), let label = AgentGuideState.label(link) {
            Button { openURL(url) } label: {
                HStack(spacing: Cockpit.Space.s1) {
                    Text(label)
                    Icon(.openOut, size: .xs)
                }
            }
            .buttonStyle(.cockpit(.secondary, size: .small))
            .accessibilityIdentifier(identifier)
        }
    }

    @ViewBuilder private var yesWaiting: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
            ForEach(said, id: \.self) { words in InPlaceLine(words, severity: .needs) }
            switch step.show {
            case .finishing:
                if let finishing = model.yes?.finishing { waitingLine(finishing) }
            case .denied:
                EmptyView()
            default:
                if case .yes(_, _, let wait, _, _, _, _, _, _, _, _, _) = own {
                    waitingLine(wait)
                    if lines.contains(.yesHint), let hint = model.words(.yesHint) {
                        Text(hint).cockpit(.subhead).foregroundStyle(Cockpit.Color.textSecondary)
                    }
                }
                if let other = model.otherSignIn, let words = model.yes?.other {
                    ListRow(words.replacingOccurrences(of: AgentGuideState.hostSlot, with: other.host ?? other.name), leading: .tile(.aiApps),
                            chevron: true, separator: false, action: { AppRuntime.shared.agents.open(signIn: other.id) })
                        .accessibilityIdentifier("guide.other")
                }
            }
        }
    }

    private var said: [String] {
        lines.filter { [.yesWrong, .yesDenied, .yesUnfinished, .yesOut].contains($0) }.compactMap(model.words)
    }

    private func waitingLine(_ words: String) -> some View {
        HStack(spacing: Cockpit.Space.s3) {
            Loading(size: .glyph).accessibilityHidden(true)
            Text(words).cockpit(.body).foregroundStyle(Cockpit.Color.text)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("guide.waiting")
    }

    @ViewBuilder private var arrived: some View {
        if let signIn = model.shownSignIn {
            VStack(alignment: .leading, spacing: Cockpit.Space.s5) {
                StepRow(number, title: signIn.head,
                        words: lines.contains(.yesWrong) ? model.words(.yesWrong) : Words.phrase(signIn.overLine, now: AppClock.now),
                        separator: false)
                WillSee(title: model.yes?.sees, reads: AgentAsks.lines(model.kept[signIn.id]?.view ?? signIn.view), change: { model.edit() })
                VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                    Text(signIn.pick).cockpit(.footnote).fontWeight(.semibold).foregroundStyle(Cockpit.Color.textSecondary)
                    NumberPick(choices: signIn.choices, sending: model.sending) { model.pick($0) }
                        .disabled(model.sending != nil)
                }
                if let failed = model.failed { InPlaceLine(failed) }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("guide.signin")
        }
    }
}

private struct GuideValueRow: View {
    let label: String?
    let text: String?
    let identifier: String
    var shares = false
    var copied: () -> Void = {}
    @State private var done = false

    var body: some View {
        HStack(alignment: .center, spacing: Cockpit.Space.s2) {
            VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
                if let label { Text(label).cockpit(.body).foregroundStyle(Cockpit.Color.text) }
                Text(text ?? "\u{2014}")
                    .cockpit(label == nil ? .body : .subhead)
                    .foregroundStyle(label == nil ? Cockpit.Color.text : Cockpit.Color.textSecondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let text, shares {
                ShareLink(item: text) {
                    Icon(.share, size: .md).foregroundStyle(Cockpit.Color.textSecondary)
                        .frame(width: Cockpit.Size.target, height: Cockpit.Size.target)
                }
                .simultaneousGesture(TapGesture().onEnded { copied() })
                .accessibilityLabel(GuideWords.share)
                .accessibilityIdentifier(identifier + ".share")
            }
            IconButton(done ? .done : .copy, label: GuideWords.copy, style: .plain) {
                guard let text else { return }
                UIPasteboard.general.string = text
                done = true
                copied()
            }
            .foregroundStyle(done ? Cockpit.Color.engaged : Cockpit.Color.textSecondary)
            .disabled(text == nil)
            .accessibilityIdentifier(identifier)
        }
        .frame(minHeight: Cockpit.Size.row)
    }
}

private struct GuideFoot: View {
    @ObservedObject var model: AgentGuideModel
    let foot: [AgentGuideState.Foot]
    let close: () -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        if !foot.isEmpty, !foot.contains(where: { $0 == .done }) || model.editor == nil {
            VStack(spacing: Cockpit.Space.s2) {
                ForEach(foot, id: \.rawValue) { part in item(part) }
            }
        }
    }

    @ViewBuilder private func item(_ part: AgentGuideState.Foot) -> some View {
        switch part {
        case .pickLine:
            if let line = model.shownSignIn?.pickLine {
                Text(line).cockpit(.footnote).foregroundStyle(Cockpit.Color.textTertiary).multilineTextAlignment(.center)
            }
        case .deny:
            Button(GuideWords.deny) { model.pick(.deny) }
                .buttonStyle(.cockpit(.plain, size: .large, busy: model.sending == .deny, fullWidth: true))
                .disabled(model.sending != nil)
                .accessibilityIdentifier("guide.deny")
        case .startAgain:
            Button(GuideWords.again) { model.startAgain() }
                .buttonStyle(.cockpit(.secondary, size: .large, fullWidth: true))
                .accessibilityIdentifier("guide.again")
        case .open:
            if let url = AgentGuideState.url(model.guide.done.open), let label = AgentGuideState.label(model.guide.done.open) {
                Button(label) { openURL(url) }
                    .buttonStyle(.cockpit(.primary, size: .large, fullWidth: true))
                    .accessibilityIdentifier("guide.open")
            }
        case .done:
            Button(GuideWords.done) { if model.finish() { close() } }
                .buttonStyle(.cockpit(model.drawn.foot.contains(.open) ? .plain : .primary, size: .large, fullWidth: true))
                .accessibilityIdentifier("guide.done")
        case .make, .makeWaits, .making:
            Button(part == .making ? GuideWords.making : model.guide.steps.compactMap(\.make).first ?? "") { model.make() }
                .buttonStyle(.cockpit(.primary, size: .large, busy: part == .making, fullWidth: true))
                .disabled(part != .make)
                .accessibilityIdentifier("guide.make")
        }
    }
}

private extension HomeLink.Pages.GuideStep {
    var make: String? {
        if case .sees(_, let make, _) = self { make } else { nil }
    }
}
