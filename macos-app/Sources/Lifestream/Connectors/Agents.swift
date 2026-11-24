import Combine
import Foundation
import HomeLink
import Passwords
import UserNotifications

extension HomeLink.AgentAsk {
    var noticeTitle: String {
        let head = Self.plain(self.head)
        return head.hasSuffix(".") ? String(head.dropLast()) : head
    }

    var noticeBody: String {
        let reason = Self.plain(self.reason ?? "")
        return reason.isEmpty ? "" : "\u{201C}" + reason + "\u{201D}"
    }

    private static func plain(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}

extension HomeLink.SignIn {
    var page: String {
        let dialog = app.map { AgentRequests.connect + "/" + AgentRequests.guide + $0 } ?? AgentRequests.signIn + id
        return "view=agents&dialog=" + (dialog.addingPercentEncoding(withAllowedCharacters: AgentRequests.inHash) ?? dialog)
    }
}

struct AgentsDoor: Sendable {
    let waiting: @Sendable () async throws -> HomeLink.AgentsWaiting?
    let answer: @Sendable (HomeLink.AnswerRequest) async throws -> HomeLink.AnswerReply
    let setAccess: @Sendable (_ reader: String, _ access: HomeLink.Access, _ expect: HomeLink.Version) async throws -> HomeLink.AccessDraft
    let link: @Sendable () throws -> HomeLink

    static func of(_ link: HomeLink, page: WaitingPage = WaitingPage()) -> AgentsDoor {
        AgentsDoor(waiting: {
            do { return try await page.read(link) } catch LinkFailure.unpaired { return nil }
        }, answer: { try await link.answer($0) }, setAccess: { try await link.setAccess($0, $1, expect: $2) }, link: { link })
    }

    static func live(_ opened: @escaping @Sendable () throws -> HomeLink) -> AgentsDoor {
        let page = WaitingPage()
        return AgentsDoor(waiting: {
            guard let link = try? opened() else { return nil }
            return try await of(link, page: page).waiting()
        }, answer: { try await of(try opened()).answer($0) }, setAccess: { try await of(try opened()).setAccess($0, $1, $2) }, link: opened)
    }
}

actor WaitingPage {
    static let key = HomeLink.PageKey(HomeLink.Pages.AgentsWaiting.route)

    private var kept: (etag: String, listed: HomeLink.AgentsWaiting)?

    func read(_ link: HomeLink) async throws -> HomeLink.AgentsWaiting {
        guard let answer = try await link.page(Self.key, etag: kept?.etag) else {
            guard let kept else { throw LinkFailure.unreadable(304) }
            return kept.listed
        }
        let listed: HomeLink.AgentsWaiting
        do {
            _ = try JSONDecoder().decode(HomeLink.Pages.AgentsWaiting.self, from: answer.value)
            listed = try JSONDecoder().decode(HomeLink.AgentsWaiting.self, from: answer.value)
        } catch {
            throw LinkFailure.unreadable(200)
        }
        kept = answer.etag.map { ($0, listed) }
        return listed
    }
}

@MainActor final class AgentRequests: ObservableObject {
    nonisolated static let notification = "agent-request"

    nonisolated static func notification(ask id: String) -> String { "agent-ask." + id }

    nonisolated static func opens(_ identifier: String) -> Bool {
        identifier == notification || identifier.hasPrefix(notification(ask: ""))
    }

    nonisolated static let title = "Lifestream"
    nonisolated static let connect = "agents:connect"
    nonisolated static let guide = "guide:"
    nonisolated static let signIn = "signin:"
    nonisolated static let inHash = CharacterSet.urlFragmentAllowed.subtracting(CharacterSet(charactersIn: "&=+"))
    private nonisolated static let pageKey = "page"

    nonisolated static func page(of content: UNNotificationContent) -> String? {
        content.userInfo[pageKey] as? String
    }

    @Published private(set) var waiting: [HomeLink.SignIn] = []
    @Published private(set) var asks: [HomeLink.AgentAsk] = []

    private let door: AgentsDoor
    private let permit: @MainActor () async -> Bool
    private let deliver: @MainActor (UNNotificationRequest) async -> Void
    private let withdraw: @MainActor ([String]) -> Void
    private let now: () -> Date
    private let every: Duration
    var inFront: () -> Bool = { false }
    private var seen: Set<String> = []
    private var due: Set<String> = []
    private var answeredHere: Set<String> = []
    private var answers = 0
    private var looking: Task<Void, Never>?
    private var notifying: Task<Void, Never>?
    private var notifyings = 0
    private var asksSeen: Set<String> = []
    private var asksDue: [String] = []
    private var asksPosted: Set<String> = []
    private var askNotifying: Task<Void, Never>?

    init(door: AgentsDoor,
         permit: @escaping @MainActor () async -> Bool = { await NotificationGrant.ask() },
         deliver: @escaping @MainActor (UNNotificationRequest) async -> Void = { try? await UNUserNotificationCenter.current().add($0) },
         withdraw: @escaping @MainActor ([String]) -> Void = {
             UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: $0)
         },
         now: @escaping () -> Date = Date.init, every: Duration = .seconds(2)) {
        self.door = door
        self.permit = permit
        self.deliver = deliver
        self.withdraw = withdraw
        self.now = now
        self.every = every
    }

    static func live(_ opened: @escaping @Sendable () throws -> HomeLink) -> AgentRequests {
        AgentRequests(door: .live(opened))
    }

    func start() {
        guard looking == nil else { return }
        let every = every
        looking = Task { [weak self] in
            while !Task.isCancelled {
                await self?.look()
                try? await Task.sleep(for: every)
            }
        }
    }

    func stop() {
        looking?.cancel()
        looking = nil
    }

    func look() async {
        let began = answers
        let listed: HomeLink.AgentsWaiting?
        do {
            listed = try await door.waiting()
        } catch {
            let ms = Int64(now().timeIntervalSince1970 * 1000)
            listed = HomeLink.AgentsWaiting(requests: waiting.filter { $0.untilMs > ms }, asks: asks.filter { $0.untilMs > ms })
        }
        guard !Task.isCancelled, began == answers else { return }
        let all = listed ?? HomeLink.AgentsWaiting()
        answeredHere.formIntersection(all.requests.map(\.id) + all.asks.map(\.id))
        show(all.requests.filter { !answeredHere.contains($0.id) }, all.asks.filter { !answeredHere.contains($0.id) })
    }

    func answered(_ id: String) {
        answers += 1
        answeredHere.insert(id)
        show(waiting.filter { $0.id != id }, asks.filter { $0.id != id })
    }

    func answer(_ request: HomeLink.AnswerRequest) async throws -> HomeLink.AnswerReply {
        do {
            let reply = try await door.answer(request)
            answered(request.id)
            return reply
        } catch let failure as LinkFailure {
            if case .refused(404, "AGENT_REQUEST_GONE", _) = failure { answered(request.id) }
            throw failure
        }
    }

    func setAccess(_ reader: String, _ access: HomeLink.Access, expect: HomeLink.Version) async throws -> HomeLink.AccessDraft {
        try await door.setAccess(reader, access, expect)
    }

    func guides() async throws -> Data {
        guard let page = try await door.link().page(HomeLink.PageKey(HomeLink.Pages.AgentGuides.route), etag: nil) else {
            throw LinkFailure.unreadable(304)
        }
        guard (try? JSONDecoder().decode(HomeLink.Pages.AgentGuides.self, from: page.value)) != nil else { throw LinkFailure.unreadable(200) }
        return page.value
    }

    func address(turnOn: Bool, reader: String?) async throws -> HomeLink.AgentAddress {
        let link = try door.link()
        guard turnOn else { return try await link.address() }
        return try await link.turnAddressOn(reader: reader)
    }

    func makeKey(_ app: HomeLink.KeyApp, name: String?, access: HomeLink.DraftAccess) async throws -> HomeLink.MadeKey {
        try await door.link().makeKey(app, name: name, access: access)
    }

    func signIn(_ id: String) async throws -> HomeLink.SignInRead {
        try await door.link().signIn(id)
    }

    private func show(_ requests: [HomeLink.SignIn], _ asks: [HomeLink.AgentAsk]) {
        let had = !waiting.isEmpty
        if requests != waiting { waiting = requests }
        if asks != self.asks { self.asks = asks }
        showSignIns(requests, had: had)
        showAsks(asks)
    }

    private func showSignIns(_ requests: [HomeLink.SignIn], had: Bool) {
        let ids = Set(requests.map(\.id))
        due = inFront() ? [] : due.union(ids.subtracting(seen)).intersection(ids)
        seen = ids
        if requests.isEmpty {
            notifying?.cancel()
            notifying = nil
            if had { withdraw([Self.notification]) }
            return
        }
        if !due.isEmpty, notifying == nil {
            notifyings += 1
            let mine = notifyings
            notifying = Task { [weak self] in await self?.notify(mine) }
        }
    }

    private func notify(_ mine: Int) async {
        while !due.isEmpty, !inFront() {
            let allowed = await permit()
            guard !Task.isCancelled else { return }
            guard allowed, !inFront() else {
                due = []
                break
            }
            guard let shown = Self.newest(waiting, of: due) else { break }
            due = []
            let content = UNMutableNotificationContent()
            content.title = Self.title
            content.body = shown.notice
            content.userInfo = [Self.pageKey: shown.page]
            await deliver(UNNotificationRequest(identifier: Self.notification, content: content, trigger: nil))
            if Task.isCancelled {
                if mine == notifyings || waiting.isEmpty { withdraw([Self.notification]) }
                return
            }
        }
        if !Task.isCancelled { notifying = nil }
    }

    private static func newest(_ waiting: [HomeLink.SignIn], of due: Set<String>) -> HomeLink.SignIn? {
        waiting.filter { due.contains($0.id) }.max { $0.atMs < $1.atMs }
    }

    private func showAsks(_ asks: [HomeLink.AgentAsk]) {
        let ids = Set(asks.map(\.id))
        let gone = asksPosted.subtracting(ids)
        if !gone.isEmpty {
            asksPosted.subtract(gone)
            withdraw(gone.sorted().map { Self.notification(ask: $0) })
        }
        let new = asks.filter { !asksSeen.contains($0.id) && $0.by == .agent }.map(\.id)
        asksSeen = ids
        asksDue = inFront() ? [] : (asksDue + new).filter(ids.contains)
        if !asksDue.isEmpty, askNotifying == nil {
            askNotifying = Task { [weak self] in await self?.notifyAsks() }
        }
    }

    private func notifyAsks() async {
        while let id = asksDue.first, !inFront() {
            let allowed = await permit()
            guard allowed else {
                asksDue = []
                break
            }
            guard asksDue.first == id, !inFront() else { continue }
            asksDue.removeFirst()
            guard let ask = asks.first(where: { $0.id == id }) else { continue }
            asksPosted.insert(id)
            let content = UNMutableNotificationContent()
            content.title = ask.noticeTitle
            content.body = ask.noticeBody
            await deliver(UNNotificationRequest(identifier: Self.notification(ask: id), content: content, trigger: nil))
            if !asks.contains(where: { $0.id == id }) {
                asksPosted.remove(id)
                withdraw([Self.notification(ask: id)])
            }
        }
        askNotifying = nil
    }
}
