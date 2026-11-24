import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI
import UIKit

@MainActor
final class AgentAsks: ObservableObject {
    static let every: Duration = .seconds(2)
    static let unsent = ReachWords.notSent
    static let unsure = ReachWords.unknown
    static let unproved = "Face ID didn't pass, so nothing was sent."

    enum Failed: Equatable {
        case said(String)
        case gone(String)
        case erased(String)
        case unsure
    }

    static func failed(_ error: Error) -> Failed {
        switch error as? LinkFailure {
        case .refused(404, "AGENT_REQUEST_GONE", let message): return .gone(message)
        case .refused(409, "AGENT_REQUEST_ERASED", let message): return .erased(message)
        case .noAnswer(sent: true): return .unsure
        default: break
        }
        switch HomeLink.ActSaid(error) {
        case .notSent: return .said(unsent)
        case .refused(let words): return .said(words)
        case .saving, .unknown: return .unsure
        }
    }

    enum Waiting: Identifiable, Equatable {
        case signIn(HomeLink.SignIn)
        case ask(HomeLink.AgentAsk)

        var id: String {
            switch self {
            case .signIn(let signIn): signIn.id
            case .ask(let ask): ask.id
            }
        }
    }

    enum Sending: Equatable {
        case pick(AgentRequestCard.Pick)
        case answer(HomeLink.AskAnswer)
    }

    struct Card: Equatable {
        var sending: AskAccessCard.Answer?
        var failed: String?
        var checking = false
    }

    enum Undo: Equatable {
        case sending
        case done
        case failed(String, again: Bool)
    }

    @Published private(set) var shown: Waiting? {
        didSet {
            if shown != nil { window?.show() }
        }
    }
    @Published private(set) var sending: Sending?
    @Published private(set) var failed: String?
    @Published private(set) var checking = false
    @Published private(set) var editor: AccessEditorModel?
    @Published private(set) var kept: [String: HomeLink.AccessDraft] = [:]
    @Published private(set) var outcome: AgentRequestCard.Ended?
    @Published private(set) var asks: [HomeLink.AgentAsk] = []
    @Published private(set) var ended: [String: HomeLink.AgentAsk] = [:]
    @Published private(set) var gone: [String: String] = [:]
    @Published private(set) var cards: [String: Card] = [:]
    @Published private(set) var undos: [String: Undo] = [:]
    @Published private(set) var erased: Set<String> = []
    @Published private(set) var polled = false
    @Published private(set) var signIns: [HomeLink.SignIn] = []

    private let link: HomeLink
    private let pages: PageShelf
    private let paired: () -> Bool
    private let clock: () -> Date
    private let prove: () async -> Bool
    private var waiting: [Waiting] = []
    private var reviewing: String?
    private var answered: Set<String> = []
    private var followed: Set<String> = []
    private var reading: Set<String> = []
    private var generation = 0
    private var asking: Task<Void, Never>?
    private var window: AgentSheetWindow?
    private var designing = false
    private var guiding: String?

    init(link: HomeLink, pages: PageShelf, paired: @escaping () -> Bool, clock: @escaping () -> Date = { AppClock.now },
         prove: @escaping () async -> Bool = { await LifeLock.shared.prove() }) {
        self.link = link
        self.pages = pages
        self.paired = paired
        self.clock = clock
        self.prove = prove
    }

    private var nowMs: Int64 { Int64((clock().timeIntervalSince1970 * 1000).rounded(.down)) }

    func hang(on scene: UIWindowScene) {
        guard window == nil else { return }
        window = AgentSheetWindow(scene: scene, asks: self)
        if shown != nil { window?.show() }
        if UIApplication.shared.applicationState != .background { cameToFront() }
    }

    func cameToFront() {
        guard asking == nil, window != nil, !designing else { return }
        asking = Task { [weak self] in
            while !Task.isCancelled {
                await self?.list()
                try? await Task.sleep(for: Self.every)
            }
        }
    }

    func showForDesign(_ waiting: Waiting, behind: [Waiting] = [], failed: String? = nil, outcome: AgentRequestCard.Ended? = nil,
                       editing: [AccessRoute]? = nil) {
        designing = true
        wentToBackground()
        self.failed = failed
        self.outcome = outcome
        self.waiting = [waiting] + behind
        shown = waiting
        if let editing {
            change()
            editor?.path = editing
        }
    }

    func standForDesign(asks: [HomeLink.AgentAsk], ended: [HomeLink.AgentAsk]) {
        designing = true
        wentToBackground()
        self.asks = asks
        polled = true
        for ask in ended {
            self.ended[ask.id] = ask
            followed.insert(ask.id)
        }
    }

    func wentToBackground() {
        asking?.cancel()
        asking = nil
    }

    func forget() {
        generation += 1
        waiting = []
        reviewing = nil
        answered = []
        followed = []
        reading = []
        sending = nil
        failed = nil
        checking = false
        editor = nil
        kept = [:]
        asks = []
        ended = [:]
        gone = [:]
        cards = [:]
        undos = [:]
        erased = []
        polled = false
        signIns = []
        outcome = nil
        shown = nil
    }


    func choices(_ ask: HomeLink.AgentAsk) -> [HomeLink.AgentAsk.Choice] {
        erased.contains(ask.id) ? ask.choices.filter { $0.answer == .no } : ask.choices
    }

    func changes(_ ask: HomeLink.AgentAsk) -> Bool {
        ask.editable && !erased.contains(ask.id)
    }

    func sentence(_ signIn: HomeLink.SignIn) -> String {
        kept[signIn.id].map { AgentsWords.plain($0.view.sentence) } ?? signIn.sentence
    }

    func reads(_ signIn: HomeLink.SignIn) -> [AgentRequestCard.Line] {
        Self.lines(kept[signIn.id]?.view ?? signIn.view)
    }

    static func lines(_ view: HomeLink.AccessView) -> [AgentRequestCard.Line] {
        [AgentRequestCard.Line(.streams, view.reads, label: AgentsWords.reads),
         AgentRequestCard.Line(.time, view.window.words, label: AgentsWords.howFarBack)]
            + (view.hide.map { [AgentRequestCard.Line(.hidden, $0.words, label: AgentsWords.hides)] } ?? [])
    }

    var place: String? {
        guard let shown, waiting.count > 1, let at = waiting.firstIndex(where: { $0.id == shown.id }) else { return nil }
        return AgentsWords.place(at + 1, of: waiting.count)
    }

    func change() {
        switch shown {
        case .signIn(let signIn):
            let start = kept[signIn.id]
            editor = AccessEditorModel(link: link, name: signIn.name, purpose: .signIn, target: .request(signIn.id),
                                       access: start?.access ?? signIn.access, expect: nil)
        case .ask(let ask):
            guard changes(ask) else { return }
            editor = AccessEditorModel(link: link, name: ask.name, purpose: .ask, target: .request(ask.id), access: ask.proposed,
                                       expect: ask.version)
        case nil:
            return
        }
        editor?.open()
    }

    func review(_ ask: HomeLink.AgentAsk) {
        guard sending == nil, outcome == nil, ask.state == .open else { return }
        reviewing = ask.id
        if !waiting.contains(where: { $0.id == ask.id }) { waiting.insert(.ask(ask), at: 0) }
        if shown?.id != ask.id {
            editor = nil
            failed = nil
            checking = false
            shown = .ask(ask)
        }
    }

    func edit(_ ask: HomeLink.AgentAsk) {
        review(ask)
        guard shown?.id == ask.id, editor == nil else { return }
        change()
    }

    func back() {
        editor = nil
    }

    func done() {
        guard let editor, editor.purpose == .signIn, case .request(let id) = editor.editing.target else { return }
        if let draft = editor.editing.draft { kept[id] = draft }
        self.editor = nil
    }

    func pick(_ pick: AgentRequestCard.Pick) {
        guard case .signIn(let signIn) = shown, sending == nil, !checking, outcome == nil else { return }
        let answer: HomeLink.AnswerRequest = switch pick {
        case .number(let number): .number(signIn.id, number, access: kept[signIn.id]?.access)
        case .deny: .deny(signIn.id)
        }
        send(.pick(pick), answer)
    }

    func answer(_ choice: HomeLink.AskAnswer) {
        guard case .ask(let ask) = shown, sending == nil, !checking, choices(ask).contains(where: { $0.answer == choice }) else { return }
        let answer: HomeLink.AnswerRequest = switch choice {
        case .once: .allow(ask.id, .once, expect: ask.version)
        case .always: .allow(ask.id, .always, expect: ask.version)
        case .no: .no(ask.id)
        }
        send(.answer(choice), answer)
    }

    func allowEdited() {
        guard case .ask(let ask) = shown, sending == nil, !checking, changes(ask), let editor, editor.editing.sending == nil,
              let draft = editor.editing.draft, let expect = draft.expect else { return }
        self.editor = nil
        send(.answer(ask.default), .allow(ask.id, ask.default == .always ? .always : .once, expect: expect, access: draft.access))
    }

    private func send(_ tap: Sending, _ answer: HomeLink.AnswerRequest) {
        sending = tap
        failed = nil
        let began = generation
        Task {
            if answer.allows, !(await prove()) {
                guard generation == began else { return }
                sending = nil
                failed = Self.unproved
                return
            }
            guard generation == began else { return }
            do {
                let reply = try await link.answer(answer)
                guard generation == began else { return }
                sending = nil
                end(answer.id, closing(reply))
            } catch {
                guard generation == began else { return }
                sending = nil
                switch Self.failed(error) {
                case .gone(let words): end(answer.id, ended(words))
                case .said(let words): failed = words
                case .erased(let words):
                    erased.insert(answer.id)
                    editor = nil
                    failed = words
                case .unsure:
                    failed = Self.unsure
                    checking = true
                    if case .ask = shown { check(answer.id) }
                }
            }
        }
    }

    private func closing(_ reply: HomeLink.AnswerReply) -> AgentRequestCard.Ended? {
        reply.outcome.map { ended(worded($0)) }
    }

    func worded(_ phrase: HomeLink.Phrase) -> String {
        Words.phrase(phrase, now: clock())
    }

    private func ended(_ words: String) -> AgentRequestCard.Ended {
        if case .signIn(let signIn) = shown { AgentRequestCard.Ended(signIn.head, words: words) } else { AgentRequestCard.Ended(words) }
    }

    private func end(_ id: String, _ closing: AgentRequestCard.Ended? = nil) {
        answered.insert(id)
        kept[id] = nil
        waiting.removeAll { $0.id == id }
        if let closing, shown?.id == id {
            editor = nil
            failed = nil
            checking = false
            outcome = closing
            return
        }
        settle()
    }

    func close() {
        guard outcome != nil else { return }
        if let id = shown?.id { answered.insert(id) }
        outcome = nil
        settle()
    }

    private func check(_ id: String) {
        guard reading.insert(id).inserted else { return }
        let began = generation
        Task {
            defer { if generation == began { reading.remove(id) } }
            do {
                let ask = try await link.agentAsk(id)
                guard generation == began, shown?.id == id else { return }
                if ask.state == .open {
                    checking = false
                } else {
                    end(id, ask.outcome.map { ended(worded($0)) })
                }
            } catch {
                guard generation == began, shown?.id == id else { return }
                if case .gone(let words) = Self.failed(error) { end(id, ended(words)) }
            }
        }
    }

    private func conclude(_ ask: HomeLink.AgentAsk) {
        editor = nil
        failed = nil
        checking = true
        guard reading.insert(ask.id).inserted else { return }
        let began = generation
        Task {
            defer { if generation == began { reading.remove(ask.id) } }
            let words: String?
            do {
                let read = try await link.agentAsk(ask.id)
                words = read.state == .open ? nil : read.outcome.map(worded)
            } catch {
                words = if case .gone(let said) = Self.failed(error) { said } else { nil }
            }
            guard generation == began, shown?.id == ask.id, outcome == nil else { return }
            checking = false
            answered.insert(ask.id)
            if let words { outcome = AgentRequestCard.Ended(words) } else { settle() }
        }
    }

    private func conclude(_ signIn: HomeLink.SignIn) {
        editor = nil
        failed = nil
        checking = true
        guard reading.insert(signIn.id).inserted else { return }
        let began = generation
        Task {
            defer { if generation == began { reading.remove(signIn.id) } }
            let words: String?
            do {
                let read = try await link.signIn(signIn.id)
                words = read.state == .gone ? signIn.over : read.outcome.map(worded)
            } catch {
                words = if case .gone = Self.failed(error) { signIn.over } else { nil }
            }
            guard generation == began, shown?.id == signIn.id, outcome == nil else { return }
            checking = false
            answered.insert(signIn.id)
            if let words { outcome = AgentRequestCard.Ended(signIn.head, words: words) } else { settle() }
        }
    }

    private func settle() {
        guard sending == nil, outcome == nil else { return }
        if let shown, let fresh = waiting.first(where: { $0.id == shown.id }) {
            if fresh != shown {
                if case .ask(let old) = shown, case .ask(let new) = fresh, old.version != new.version || old.state != new.state {
                    editor = nil
                }
                self.shown = fresh
            }
            return
        }
        switch shown {
        case .signIn(let signIn) where !answered.contains(signIn.id):
            return conclude(signIn)
        case .ask(let ask) where !answered.contains(ask.id):
            return conclude(ask)
        default:
            break
        }
        failed = nil
        checking = false
        editor = nil
        shown = waiting.first
    }


    func guide(_ app: String?) {
        guiding = app
        waiting.removeAll { if case .signIn(let signIn) = $0 { guided(signIn) } else { false } }
        if case .signIn(let signIn) = shown, guided(signIn), sending == nil, outcome == nil {
            editor = nil
            failed = nil
            checking = false
            shown = waiting.first
        }
    }

    func answeredInGuide(_ id: String) {
        answered.insert(id)
        kept[id] = nil
        signIns.removeAll { $0.id == id }
        waiting.removeAll { $0.id == id }
    }

    func open(signIn id: String) {
        guard sending == nil, outcome == nil, let signIn = waiting.first(where: { $0.id == id }) else { return }
        editor = nil
        failed = nil
        checking = false
        shown = signIn
    }

    private func guided(_ signIn: HomeLink.SignIn) -> Bool {
        guiding != nil && signIn.app == guiding
    }

    func follow(_ ask: String) {
        guard followed.insert(ask).inserted else { return }
        readEnded()
    }

    func listed(_ ask: String) -> HomeLink.AgentAsk? {
        asks.first { $0.id == ask }
    }

    func answerChat(_ ask: HomeLink.AgentAsk, _ choice: AskAccessCard.Answer) {
        guard cards[ask.id]?.sending == nil, cards[ask.id]?.checking != true, choice == .no || changes(ask) else { return }
        cards[ask.id, default: Card()].sending = choice
        cards[ask.id]?.failed = nil
        let answer: HomeLink.AnswerRequest = choice == .allow ? .allow(ask.id, .always, expect: ask.version) : .no(ask.id)
        let began = generation
        Task {
            if answer.allows, !(await prove()) {
                guard generation == began else { return }
                cards[ask.id]?.sending = nil
                cards[ask.id]?.failed = Self.unproved
                return
            }
            guard generation == began else { return }
            do {
                _ = try await link.answer(answer)
                guard generation == began else { return }
                cards[ask.id] = Card(checking: true)
                answered.insert(ask.id)
                asks.removeAll { $0.id == ask.id }
                read(ask.id)
            } catch {
                guard generation == began else { return }
                cards[ask.id]?.sending = nil
                let failed = Self.failed(error)
                switch failed {
                case .said(let words): cards[ask.id]?.failed = words
                case .erased(let words):
                    erased.insert(ask.id)
                    cards[ask.id]?.failed = words
                case .gone, .unsure:
                    cards[ask.id]?.failed = failed == .unsure ? Self.unsure : nil
                    cards[ask.id]?.checking = true
                    read(ask.id)
                }
            }
        }
    }

    func undo(_ change: String, reader: String, _ undo: HomeLink.Narrowed.Undo) {
        switch undos[change] {
        case nil, .failed(_, again: true)?: break
        default: return
        }
        undos[change] = .sending
        let began = generation
        Task {
            if !(await prove()) {
                guard generation == began else { return }
                undos[change] = .failed(Self.unproved, again: true)
                return
            }
            guard generation == began else { return }
            do {
                _ = try await link.setAccess(reader, undo.access, expect: undo.expect)
                guard generation == began else { return }
                undos[change] = .done
            } catch {
                guard generation == began else { return }
                let refused = if case .refused? = error as? LinkFailure { true } else { false }
                undos[change] = switch Self.failed(error) {
                case .unsure: .failed(Self.unsure, again: true)
                case .gone: .failed(Self.unsent, again: true)
                case .said(let words), .erased(let words): .failed(words, again: !refused)
                }
            }
        }
    }

    private func readEnded() {
        for id in followed where listed(id) == nil && ended[id] == nil && gone[id] == nil && cards[id]?.sending == nil { read(id) }
    }

    private func read(_ id: String) {
        guard paired(), reading.insert(id).inserted else { return }
        let began = generation
        Task {
            defer { if generation == began { reading.remove(id) } }
            do {
                let ask = try await link.agentAsk(id)
                guard generation == began else { return }
                if ask.state != .open {
                    ended[id] = ask
                    cards[id] = nil
                } else {
                    cards[id]?.checking = false
                    if !asks.contains(where: { $0.id == id }), ask.untilMs > nowMs { asks.append(ask) }
                }
            } catch LinkFailure.refused(404, "AGENT_REQUEST_GONE", let words) {
                guard generation == began else { return }
                gone[id] = words
                cards[id] = nil
            } catch {
            }
        }
    }


    func list() async {
        guard paired() else { return land(HomeLink.AgentsWaiting(), fresh: false) }
        let began = generation
        for await drawn in pages.reading(WaitingAnswer.self, WaitingAnswer.key) {
            guard generation == began, !Task.isCancelled else { return }
            switch drawn.state {
            case .kept:
                continue
            case .fresh:
                guard let page = drawn.page else { continue }
                return land(page.listed, fresh: true)
            default:
                return land(HomeLink.AgentsWaiting(requests: signIns, asks: asks), fresh: false)
            }
        }
    }

    private func land(_ listed: HomeLink.AgentsWaiting, fresh: Bool) {
        let now = nowMs
        answered.formIntersection(listed.requests.map(\.id) + listed.asks.map(\.id))
        asks = listed.asks.filter { !answered.contains($0.id) && (fresh || $0.untilMs > now) }
        signIns = listed.requests.filter { !answered.contains($0.id) }
        waiting = signIns.filter { !guided($0) }.map(Waiting.signIn)
            + asks.filter { $0.by == .agent || $0.id == reviewing }.map(Waiting.ask)
        kept = kept.filter { id, _ in waiting.contains { $0.id == id } }
        if fresh {
            polled = true
            if checking, let shown, waiting.contains(where: { $0.id == shown.id }) {
                if case .signIn = shown { checking = false } else { check(shown.id) }
            }
            for (id, card) in cards where card.checking { read(id) }
        }
        settle()
        readEnded()
    }
}

@MainActor
private final class AgentSheetWindow {
    private let window: UIWindow
    private weak var before: UIWindow?

    init(scene: UIWindowScene, asks: AgentAsks) {
        window = UIWindow(windowScene: scene)
        window.windowLevel = UIWindow.Level(rawValue: UIWindow.Level.normal.rawValue + 1)
        window.backgroundColor = .clear
        window.isHidden = true
        let host = UIHostingController(rootView: AgentSheetHost(asks: asks) { [weak self, weak asks] in
            if asks?.shown == nil { self?.hide() }
        })
        host.view.backgroundColor = .clear
        window.rootViewController = host
    }

    func show() {
        guard window.isHidden else { return }
        before = window.windowScene?.keyWindow
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        window.makeKeyAndVisible()
    }

    private func hide() {
        window.isHidden = true
        before?.makeKey()
    }
}

private struct AgentSheetHost: View {
    @ObservedObject var asks: AgentAsks
    let closed: () -> Void

    var body: some View {
        Color.clear
            .sheet(item: Binding(get: { asks.shown }, set: { _ in }), onDismiss: closed) { waiting in
                AgentSheet(asks: asks, waiting: waiting)
            }
            .modifier(UITestAppearanceOverride())
            .tint(Cockpit.Color.text)
    }
}

private struct AgentSheet: View {
    @ObservedObject var asks: AgentAsks
    let waiting: AgentAsks.Waiting

    var body: some View {
        card
            .drawerRest()
            .interactiveDismissDisabled()
            .sheet(item: Binding(get: { asks.editor }, set: { if $0 == nil { asks.back() } })) { editor in
                AccessEditorSheet(model: editor, answering: asks.sending != nil) {
                    asks.back()
                } finish: {
                    if editor.purpose == .signIn { asks.done() } else { asks.allowEdited() }
                }
                .modifier(UITestAppearanceOverride())
            }
    }

    @ViewBuilder private var card: some View {
        switch waiting {
        case .signIn(let signIn):
            AgentRequestCard(head: signIn.head, line: asks.worded(signIn.overLine), pickTitle: signIn.pick, pickLine: signIn.pickLine, choices: signIn.choices,
                             sentence: asks.sentence(signIn), reads: asks.reads(signIn), change: { asks.change() },
                             sending: { if case .pick(let pick) = asks.sending { pick } else { nil } }(), failed: asks.failed,
                             ended: asks.outcome, done: { asks.close() }) {
                asks.pick($0)
            }
            .disabled(asks.checking)
            .accessibilityIdentifier("agent.request")
        case .ask(let ask):
            AgentAskCard(name: ask.name, icon: AgentsStore.icon(.agent),
                         when: AgentsWords.time(ask.atMs), place: asks.outcome == nil ? asks.place : nil,
                         head: ask.head, says: ask.saysTitle, fact: AgentsWords.plain(ask.today), today: AgentsWords.runs(ask.today),
                         reason: ask.reason, screen: ask.screen,
                         choices: asks.choices(ask).compactMap { choice in
                             AgentAskCard.Answer(rawValue: choice.answer.rawValue).map { AgentAskCard.Choice($0, choice.words) }
                         },
                         preferred: AgentAskCard.Answer(rawValue: ask.default.rawValue) ?? .once,
                         sending: { if case .answer(let answer) = asks.sending { AgentAskCard.Answer(rawValue: answer.rawValue) } else { nil } }(),
                         failed: asks.failed, outcome: asks.outcome?.title, change: asks.changes(ask) ? { asks.change() } : nil,
                         done: { asks.close() }) { answer in
                asks.answer(HomeLink.AskAnswer(rawValue: answer.rawValue) ?? .no)
            }
            .disabled(asks.checking)
            .accessibilityIdentifier("agent.ask")
        }
    }
}

struct AgentSheetAnchor: UIViewRepresentable {
    func makeUIView(context: Context) -> Anchor { Anchor() }
    func updateUIView(_ view: Anchor, context: Context) {}

    final class Anchor: UIView {
        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard let scene = window?.windowScene else { return }
            AppRuntime.shared.agents.hang(on: scene)
        }
    }
}
