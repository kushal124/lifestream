import HomeLink
import LifestreamCaptureCore
import UIKit
import AppIntents
import Cockpit
import Foundation
import HomeLink
import Observation
import SwiftUI

@MainActor @Observable
final class AppNavigation {
    enum Tab: Hashable, CaseIterable {
        case ask, days, people, places, agents, search

        var title: String {
            switch self {
            case .ask: "Chat"
            case .days: "Timeline"
            case .people: "People"
            case .places: "Places"
            case .agents: "Agents"
            case .search: "Search"
            }
        }
    }

    enum Presented: Hashable, Identifiable {
        case streams
        case search
        case stream(StreamSheet)
        case reach
        case notes(NotesOpening)
        case camera
        case voiceNote
        var id: Self { self }
    }

    static let shared = AppNavigation()
    var selectedTab: Tab = .ask {
        didSet {
            if selectedTab != .ask { conversationsOpen = false }
            if selectedTab != oldValue {
                Interaction.tabSwitch.begin()
                Interaction.tabSwitch.endAtCommit()
            }
        }
    }
    private var paths: [Tab: [LifeRoute]] = [:]
    var presented: Presented? {
        didSet {
            if presented != nil, presented != oldValue {
                Interaction.sheet.begin()
                Interaction.sheet.endAtCommit()
            }
        }
    }
    var afterSheet: (@MainActor () -> Void)?
    var designSearch: String?
    var conversationsOpen = false
    var checkInRoute: CheckInRoute?

    func path(_ tab: Tab) -> Binding<[LifeRoute]> {
        _ = paths[tab]
        return Binding(get: { self.paths[tab] ?? [] }, set: { self.paths[tab] = $0 })
    }

    func holds(_ route: LifeRoute) -> Bool {
        paths.values.contains { $0.contains(route) }
    }

    func open(_ route: LifeRoute, in tab: Tab) {
        presented = nil
        selectedTab = tab
        paths[tab, default: []].append(route)
    }

    func openChat(_ key: String) {
        presented = nil
        selectedTab = .ask
        conversationsOpen = false
        var still = Transaction()
        still.disablesAnimations = true
        withTransaction(still) { paths[.ask] = [.chat(key)] }
    }

    func newChat() {
        selectedTab = .ask
        conversationsOpen = false
        var still = Transaction()
        still.disablesAnimations = true
        withTransaction(still) { paths[.ask] = [] }
        AskBook.shared.focus = true
    }

    var drawerFromEdge: Bool {
        guard selectedTab == .ask, presented == nil else { return false }
        guard let top = paths[.ask]?.last else { return true }
        if case .chat = top { return true }
        return false
    }

    func openRoot(of tab: Tab) {
        presented = nil
        conversationsOpen = false
        selectedTab = tab
        paths[tab] = []
    }

    func push(_ route: LifeRoute) {
        if presented == .search { return pushInSearch(route) }
        open(route, in: selectedTab)
    }

    func pushInSearch(_ route: LifeRoute) {
        paths[.search, default: []].append(route)
    }

    func present(_ destination: Presented) {
        presented = destination
    }

    func openStream(_ id: String) {
        present(.stream(.of(id)))
    }

    func whenClear(_ then: @escaping @MainActor () -> Void) {
        guard presented != nil else { return then() }
        afterSheet = then
        presented = nil
    }

    func shown(locked: Bool) -> Presented? {
        if locked, case .notes = presented { return nil }
        if locked, presented == .search { return nil }
        return presented
    }

    var waitsBehindLock: Bool {
        checkInRoute != nil || shown(locked: true) != presented
    }

    func openCheckIn(_ route: CheckInRoute) {
        presented = nil
        selectedTab = .days
        checkInRoute = route
    }
}

extension AppNavigation {
    func openForDesign() {
        let arguments = ProcessInfo.processInfo.arguments
        guard AppRuntime.isUITesting, let at = arguments.firstIndex(of: "--ui-test-open"), at + 1 < arguments.count else { return }
        let parts = arguments[at + 1].split(separator: ":", maxSplits: 1).map(String.init)
        let value = parts.count > 1 ? parts[1] : ""
        func day(_ back: String) -> String {
            Words.shiftDay(HomeClock.current.today(), Int(back) ?? 0)
        }
        switch parts[0] {
        case "days": selectedTab = .days
        case "people": selectedTab = .people
        case "places": selectedTab = .places
        case "search":
            present(.search)
            designSearch = value
        case "chat":
            selectedTab = .ask
            if AppRuntime.asked("--ui-test-keyboard") { AskBook.shared.focus = true }
        case "conversations":
            selectedTab = .ask
            conversationsOpen = true
        case "day": open(.day(day(value)), in: .days)
        case "person": open(.person("person:" + value), in: .people)
        case "personphotos":
            open(.person("person:" + value), in: .people)
            open(.personPhotos("person:" + value), in: .people)
        case "group": open(.group(value), in: .people)
        case "place": open(.place(value), in: .places)
        case "trip": open(.trip(value), in: .places)
        case "thread":
            guard value == "first" else { return openChat(value) }
            Task {
                await AskBook.shared.read()
                guard let first = AskBook.shared.conversations.first else { return }
                openChat(first.id)
                let conversation = AskBook.shared.conversation(first.id)
                if AppRuntime.asked("--ui-test-grown") {
                    conversation.draft = "Read everything from the trip in September and tell me:\n- where we stayed each night\n- who joined for which part\n- what it cost in all\n- and what we said we would do again"
                }
                if AppRuntime.asked("--ui-test-keyboard") { conversation.focus = true }
            }
        case "hidden": open(.hiddenSpots, in: .places)
        case "visits": open(.placeVisits(value), in: .places)
        case "checkin": checkInRoute = CheckInRoute(destination: .moment)
        case "notes": present(.notes(.folders))
        case "allnotes":
            try? AppRuntime.shared.notes.keep { store in
                let folder = try store.defaultFolder()
                for n in 1...24 {
                    let note = try store.createNote(in: folder)
                    try store.updateContent(note, attributed: NSAttributedString(string: "Note \(n)\nA synthetic line to fill the list"))
                }
            }
            present(.notes(.allNotes))
        case "streams": present(.streams)
        case "stream": openStream(value)
        case "import": present(.stream(.importKind(value)))
        case "yourhome": present(.stream(.yourHome))
        case "month": open(.month(value), in: .days)
        case "thisphone": present(.stream(.thisPhone))
        case "agent-request":
            Self.designSignIn(id: "agent-design", name: "ChatGPT", checked: true, host: "chatgpt.com", choices: [14, 82, 37])
        case "agent-request-long":
            Self.designSignIn(id: "agent-design", name: "Hermes Research Assistant for the Quarterly Planning Workspace", checked: false,
                              host: "hermes.example.com", choices: [90, 12, 45])
        case "agent-request-no":
            Self.designSignIn(id: "agent-design", name: "ChatGPT", checked: true, host: "chatgpt.com", choices: [14, 82, 37]) { _ in
                Self.cannedOutcome("answer-sign-in-wrong")
            }
        case "agent-request-over":
            Self.designSignIn(id: "agent-design", name: "ChatGPT", checked: true, host: "chatgpt.com", choices: [14, 82, 37]) { $0.over }
        case "way-in":
            AppRuntime.shared.agents.standForDesign(asks: Self.cannedAsks, ended: [])
            present(.streams)
        case "agent-request-failed":
            Self.designSignIn(id: "agent-design", name: "Claude", checked: true, host: "claude.ai", choices: [27, 64, 13], failed: AgentAsks.unsure)
        case "agent-access":
            Self.designSignIn(id: "c2lnbi1pbi0wMDAwMDAwMQ", name: "Claude", checked: true, host: "claude.ai", choices: [27, 64, 13], editing: [])
        case "agent-access-category":
            Self.designSignIn(id: "c2lnbi1pbi0wMDAwMDAwMQ", name: "Claude", checked: true, host: "claude.ai", choices: [27, 64, 13],
                              editing: [.category("mail")])
        case "agent-access-time":
            Self.designSignIn(id: "c2lnbi1pbi0wMDAwMDAwMQ", name: "Claude", checked: true, host: "claude.ai", choices: [27, 64, 13],
                              editing: [.time(.all)])
        case "agent-access-hiding":
            Self.designSignIn(id: "c2lnbi1pbi0wMDAwMDAwMQ", name: "Claude", checked: true, host: "claude.ai", choices: [27, 64, 13],
                              editing: [.hiding])
        case "agents":
            AppRuntime.shared.agents.standForDesign(asks: CannedHome.Agents.asks(now: Int64(AppClock.now.timeIntervalSince1970 * 1000))
                .compactMap { try? JSONSerialization.data(withJSONObject: $0) }
                .compactMap { try? JSONDecoder().decode(HomeLink.AgentAsk.self, from: $0) }, ended: [])
            selectedTab = .agents
            let asked = value.split(separator: ":").map(String.init)
            let edit: HomeLink.Edit? = switch asked.last {
            case "widen": .type("health", on: true)
            case "narrow": .window(.past(ms: 86_400_000))
            case "only": .mode(.only)
            default: nil
            }
            if asked.last == "disconnected", let id = asked.first {
                Task {
                    await AgentsStore.shared.read(id)
                    _ = await AgentsStore.shared.disconnect(id)
                }
            }
            if let edit, let id = asked.first {
                Task {
                    await AgentsStore.shared.read(id)
                    AgentsStore.shared.editor(id)?.tap(edit)
                }
            }
        case "agent-ask":
            Self.designAsk(value)
        case "agent-ask-two":
            Self.designAsk(value, behind: 1)
        case "agent-ask-after":
            Self.designAsk(value, outcome: Self.cannedOutcome("answer-once"))
        case "agent-ask-change":
            Self.designAsk(value, editing: [])
        case "agent-chat", "agent-chat-ended", "agent-chat-screen":
            let asks = CannedHome.Agents.asks(now: Int64(AppClock.now.timeIntervalSince1970 * 1000))
                .compactMap { try? JSONSerialization.data(withJSONObject: $0) }
                .compactMap { try? JSONDecoder().decode(HomeLink.AgentAsk.self, from: $0) }
            let ended = CannedHome.Agents.decoded(HomeLink.AgentAsk.self, "ask-replaced").map { [$0] } ?? []
            let waits = parts[0] != "agent-chat-ended"
            AppRuntime.shared.agents.standForDesign(asks: waits ? asks : [], ended: waits ? [] : ended)
            Task {
                await AskBook.shared.read()
                if let first = AskBook.shared.conversations.first { open(.chat(first.id), in: .ask) }
            }
        default: break
        }
        if let at = arguments.firstIndex(of: "--ui-test-scroll"), at + 1 < arguments.count, let y = Double(arguments[at + 1]) {
            let wait = arguments.firstIndex(of: "--ui-test-scroll-wait").flatMap { $0 + 1 < arguments.count ? Double(arguments[$0 + 1]) : nil }
            Task {
                try? await Task.sleep(for: .seconds(wait ?? 1.8))
                Self.scrollFront(to: y)
            }
        }
    }

    private static var cannedAsks: [HomeLink.AgentAsk] {
        CannedHome.Agents.asks(now: Int64(AppClock.now.timeIntervalSince1970 * 1000))
            .compactMap { try? JSONSerialization.data(withJSONObject: $0) }
            .compactMap { try? JSONDecoder().decode(HomeLink.AgentAsk.self, from: $0) }
    }

    private static func cannedOutcome(_ name: String) -> String? {
        ((CannedHome.Agents.contract(name)["answer"] as? [String: Any])?["outcome"])
            .flatMap { try? JSONSerialization.data(withJSONObject: $0) }
            .flatMap { try? JSONDecoder().decode(HomeLink.Phrase.self, from: $0) }
            .map { Words.phrase($0) }
    }

    private static func designSignIn(id: String, name: String, checked: Bool, host: String, choices: [Int], failed: String? = nil,
                                     editing: [AccessRoute]? = nil, outcome: ((HomeLink.SignIn) -> String?)? = nil) {
        guard var signIn = (CannedHome.Agents.decoded(HomeLink.AgentsWaiting.self, "waiting-sign-in"))?.requests.first else { return }
        let named = signIn.name
        if let from = signIn.host {
            signIn.over = signIn.over.replacingOccurrences(of: from, with: host)
            signIn.overLine = signIn.overLine.replacing(from, with: host)
        }
        signIn.pick = signIn.pick.replacingOccurrences(of: named, with: name)
        signIn.pickLine = signIn.pickLine.replacingOccurrences(of: named, with: name)
        signIn.id = id
        signIn.name = name
        signIn.checked = checked
        signIn.host = host
        signIn.choices = choices
        signIn.untilMs = Int64((AppClock.now.timeIntervalSince1970 + 600) * 1000)
        signIn.sentence = name + String(signIn.sentence.dropFirst(named.count))
        signIn.head = signIn.head.replacingOccurrences(of: named, with: name)
        let ended = outcome.map { words in AgentRequestCard.Ended(signIn.head, words: words(signIn)) }
        AppRuntime.shared.agents.showForDesign(.signIn(signIn), failed: failed, outcome: ended, editing: editing)
    }

    private static func designAsk(_ which: String, behind: Int = 0, outcome: String? = nil, editing: [AccessRoute]? = nil) {
        if which == "erased", var erased = CannedHome.Agents.decoded(HomeLink.AgentAsk.self, "ask-erased") {
            erased.untilMs = Int64((AppClock.now.timeIntervalSince1970 + 86_400) * 1000)
            return AppRuntime.shared.agents.showForDesign(.ask(erased), editing: editing)
        }
        let asks = CannedHome.Agents.asks(now: Int64(AppClock.now.timeIntervalSince1970 * 1000))
            .compactMap { try? JSONSerialization.data(withJSONObject: $0) }
            .compactMap { try? JSONDecoder().decode(HomeLink.AgentAsk.self, from: $0) }
            .filter { $0.by == .agent }
        guard let ask = asks.first(where: { $0.under != nil }) else { return }
        AppRuntime.shared.agents.showForDesign(.ask(ask), behind: asks.filter { $0.id != ask.id }.prefix(behind).map(AgentAsks.Waiting.ask),
                                               outcome: outcome.map { AgentRequestCard.Ended($0) }, editing: editing)
    }

    static var designPush: [ConnectorsRoute] {
        let arguments = ProcessInfo.processInfo.arguments
        if AppRuntime.isUITesting, let at = arguments.firstIndex(of: "--ui-test-open"), at + 1 < arguments.count,
           arguments[at + 1].hasPrefix("agents") {
            return designAgents(arguments[at + 1].split(separator: ":").dropFirst().map(String.init))
        }
        guard AppRuntime.isUITesting, let at = arguments.firstIndex(of: "--ui-test-push"), at + 1 < arguments.count else { return [] }
        let asked = arguments[at + 1].split(separator: ":").map(String.init)
        switch asked.first {
        case "ai" where asked.count == 3: return [.processing(asked[1], asked[2])]
        case "signin" where asked.count == 3: return [.signIn(asked[1], asked[2])]
        default: break
        }
        switch arguments[at + 1] {
        case "status": return [.status]
        case "details": return [.status, .statusDetails]
        case "checkins": return [.checkIns]
        #if !APP_STORE
        case "experiments": return [.experiments]
        #endif
        default: return []
        }
    }

    private static func designAgents(_ asked: [String]) -> [ConnectorsRoute] {
        var routes: [ConnectorsRoute] = [.agents]
        if asked.first == "connect" { return routes + [.connect] }
        guard let id = asked.first, asked.dropFirst().first != "listed" else { return routes }
        routes.append(.agent(id))
        if asked.count > 1, asked[1] == "history" { return routes + [.history(id)] }
        if asked.count > 2, asked[1] == "read" { return routes + [.history(id), .read(id, asked[2])] }
        if asked.count > 2, asked[1] == "things" { return routes + [.history(id), .read(id, asked[2]), .things(id, asked[2])] }
        if asked.count > 1, asked[1] == "disconnect" { return routes + [.disconnect(id)] }
        guard asked.count > 1, asked[1] == "access" else { return routes }
        routes.append(.access(id, nil))
        let parts: [AccessRoute] = asked.dropFirst(2).compactMap { part in
            switch part {
            case "time": .time(.all)
            case "hiding": .hiding
            case "custom": .custom
            default: part.hasPrefix("category=") ? .category(String(part.dropFirst("category=".count))) : nil
            }
        }
        return routes + parts.map { .access(id, $0) }
    }

    private static func scrollFront(to y: Double) {
        guard let window = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first,
              var front = window.rootViewController else { return }
        while let next = front.presentedViewController { front = next }
        func all(_ view: UIView) -> [UIScrollView] { ((view as? UIScrollView).map { [$0] } ?? []) + view.subviews.flatMap(all) }
        func shownWhole(_ view: UIView) -> Bool {
            var at: UIView? = view
            while let view = at {
                if view.isHidden || view.alpha < 0.01 { return false }
                at = view.superview
            }
            return true
        }
        func onScreen(_ view: UIView) -> Bool {
            view.window != nil && shownWhole(view) && abs(view.convert(view.bounds, to: nil).minX) < 20
        }
        func tops(_ controller: UIViewController) -> [UIViewController] {
            let deeper = controller.children.filter { onScreen($0.view) }.flatMap(tops)
            guard let stack = controller as? UINavigationController, let top = stack.topViewController else { return deeper }
            return deeper.isEmpty ? [top] : deeper
        }
        let shown = all(tops(front).last?.view ?? front.view).filter { view in
            view.contentSize.height > view.bounds.height + 1 && onScreen(view)
        }
        guard let scroll = shown.max(by: { $0.bounds.height < $1.bounds.height }) else { return }
        let end = scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height
        scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: min(y - scroll.adjustedContentInset.top, end)), animated: false)
    }
}

struct OpenLifestreamNotes: AppIntent {
    static var title: LocalizedStringResource { "Open Notes" }
    static var description: IntentDescription { "Open your private Lifestream notes." }
    static var openAppWhenRun: Bool { true }

    @MainActor
    func perform() async throws -> some IntentResult {
        AppNavigation.shared.present(.notes(.folders))
        return .result()
    }
}

struct OpenLifestreamCamera: AppIntent {
    static var title: LocalizedStringResource { "Open Camera" }
    static var description: IntentDescription { "Open the Lifestream camera to capture a moment." }
    static var openAppWhenRun: Bool { true }

    @MainActor
    func perform() async throws -> some IntentResult {
        AppNavigation.shared.present(.camera)
        return .result()
    }
}

struct LifestreamShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: OpenLifestreamNotes(),
            phrases: ["Open my notes in \(.applicationName)", "Open \(.applicationName) notes"],
            shortTitle: "Open Notes",
            systemImageName: "note.text"
        )
        AppShortcut(
            intent: OpenLifestreamCamera(),
            phrases: ["Open \(.applicationName) camera", "Take a photo with \(.applicationName)"],
            shortTitle: "Open Camera",
            systemImageName: "camera"
        )
    }
}
