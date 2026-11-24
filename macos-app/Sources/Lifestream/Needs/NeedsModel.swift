import Combine
import Foundation
import HomeLink
import Passwords

@MainActor final class NeedsModel: ObservableObject {
    @Published private(set) var list: [Need] = []
    @Published private(set) var vault: VaultState?
    @Published private(set) var refusals: [String: String] = [:]
    @Published private(set) var working: Set<String> = []
    @Published private(set) var saved: Set<String> = []
    @Published private(set) var drafts: [String: String] = [:]
    @Published private(set) var holding: String?
    @Published private(set) var elsewhere: [String] = []
    @Published private(set) var opening = false
    @Published private(set) var openingNeed: String?
    @Published private(set) var notKept: String?
    private(set) var reached = false
    private(set) var doorSaid: DoorAnswer?
    let recovery: RecoveryKey

    var changed: (() -> Void)?
    var began: (([Need]) -> Void)?
    var retryUpdate: () async -> UpdateFailure? = { nil }
    var installUpdate: () -> Void = {}
    var knock: () async -> Void = {}
    var openKey: (RecoveryKey.Door) -> Void = { _ in }
    var restartDoor: () async -> Void = {}
    var door: () async -> DoorAnswer = { .silent }
    var macFiles: () async -> MacFilesNeed? = { nil }
    var openFiles: () async -> String? = { nil }
    var doorPace: Duration = .seconds(1)
    var keepWithin = VaultKeeper.keepWithin

    private let keeper: VaultKeeper
    private var keyHeld = true
    private var opensNot: String?
    private var home: [HomeLink.Need] = []
    private var update: UpdateFailure?
    private var ready: String?
    private var files: MacFilesNeed?
    private var watch = NeedWatch()
    private let reads = OneRead()
    private var hearing: Task<Void, Never>?
    private var asks = 0
    private var heard = 0
    private var unkept: Unkept?

    private enum Unkept {
        case refused(String)
        case waited(String)

        var words: String {
            switch self {
            case .refused(let words), .waited(let words): words
            }
        }
    }

    enum Cover: Equatable {
        case opening(need: String?)
        case notKept(String)
        case locked(allow: Bool)
    }

    static let doorTries = 90
    static let notHanded = "macOS didn't let Lifestream read its key without asking. When macOS asks, choose Always Allow."
    static let doorKeyless = "Lifestream started without this Mac's key."
    static let slotMissing = "Without it, Lifestream asks for the recovery key the next time it starts."

    init(keeper: VaultKeeper, recovery: RecoveryKey) {
        self.keeper = keeper
        self.recovery = recovery
        recovery.needs = self
    }

    var vaultNeed: Need? { list.first(where: \.locks) }

    var homeLocked: Need? { list.first { if case .homeLocked = $0 { true } else { false } } }

    var lockedWhy: String? { vault?.why }

    var cover: Cover? {
        if opening { return .opening(need: openingNeed) }
        if let notKept { return .notKept(notKept) }
        if case .homeLocked(let allow)? = homeLocked { return .locked(allow: allow) }
        return nil
    }

    func updated(_ failure: UpdateFailure?) {
        update = failure
        recompute()
    }

    func update(holding: String?, waiting: String?) {
        self.holding = holding
        ready = waiting
        recompute()
    }

    var heldUpdate: Need? { holding.map(Need.updateReady) }

    func noticed(_ found: [HomeLink.Need]) {
        guard found != home else { return }
        home = found
        recompute()
        Task { await read() }
    }

    func read() async {
        await reads.run { [weak self] in
            guard let self else { return }
            await recovery.settle()
            files = await macFiles()
            let read = await keeper.read()
            reached = if case .state = read { true } else { false }
            if case .state(let state) = read {
                keyHeld = state.locked ? await keeper.holdsKey() : true
                if !state.locked || state.keyID != opensNot { opensNot = nil }
                if !keyHeld { opensNot = state.keyID }
                elsewhere = keeper.elsewhere(state)
                if state.locked { forgetDoor() }
                notKept = state.keyed && !state.locked ? await keyNotKept(state) : nil
                vault = state
                if state.keyed && !state.locked { hear() }
            } else {
                forgetDoor()
                if case .refused? = unkept { unkept = nil }
                notKept = unkept?.words
            }
            recompute()
        }
    }

    @discardableResult
    func allow() -> Task<String?, Never>? {
        let locked = vault?.keyID
        let keyed = vault?.keyed == true
        return act(Need.allow.key) { [weak self, keeper] in
            do {
                try await keeper.allow()
                if keyed { self?.open(keeping: false) }
                return nil
            } catch {
                if (error as? VaultRefusal)?.wrongKey == true { self?.opensNot = locked }
                return Self.said(error, else: keyed ? "Lifestream couldn't open its data on this Mac. Try again."
                                                    : "Lifestream couldn't open your passwords on this Mac. Try again.")
            }
        }
    }

    @discardableResult
    func allowFiles() -> Task<String?, Never>? {
        act(Need.filesRefused.key) { [weak self, openFiles] in
            if let refusal = await openFiles() { return refusal }
            if self?.list.contains(.allow) == true { self?.allow() }
            return nil
        }
    }

    @discardableResult
    func unlock(_ typed: String) -> Task<String?, Never>? {
        let keyed = vault?.keyed == true
        return act(Need.unlock.key) { [weak self, keeper] in
            guard !typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return "Type the recovery key first." }
            do {
                try await keeper.recover(typed)
                if keyed { self?.open(keeping: true) }
                return nil
            } catch {
                let refused = Self.refusal(error, else: keyed ? "Lifestream couldn't unlock its data on this Mac. Try again."
                                                              : "Lifestream couldn't unlock your passwords on this Mac. Try again.")
                return refused.said == .refused ? Self.sentence(refused.words) : refused.words
            }
        }
    }

    func keepAgain() {
        guard notKept != nil, !opening else { return }
        open(keeping: true)
    }

    private func keyNotKept(_ state: VaultState) async -> String? {
        let kept = await keeper.kept(in: state)
        if kept == .kept, case .refused? = unkept { unkept = nil }
        if case .refused(let words)? = unkept { return words }
        switch kept {
        case .kept, .unread: return doorSaid == .locked ? Self.doorKeyless : nil
        case .notKept: return Self.slotMissing
        case .untrusted: return Self.notHanded
        }
    }

    private func asked() async -> DoorAnswer {
        asks += 1
        let asking = asks
        let answer = await door()
        if asking > heard {
            heard = asking
            doorSaid = answer
        }
        return answer
    }

    private func forgetDoor() {
        doorSaid = nil
        heard = asks
    }

    private func hear() {
        guard hearing == nil else { return }
        let before = doorSaid
        hearing = Task {
            _ = await asked()
            hearing = nil
            if doorSaid != before { await read() }
        }
    }

    static func notOpened(held: String?, after limit: TimeInterval) -> String {
        let minutes = max(1, Int((limit / 60).rounded(.up)))
        let waited = minutes == 1 ? "a minute" : "\(minutes) minutes"
        guard let held, let last = held.last else {
            return "Lifestream didn't open on this Mac within \(waited). Press Try again once it runs."
        }
        return "\(held)\(".!?".contains(last) ? "" : ".") This Mac stopped waiting after \(waited): press Try again once that ends."
    }

    private func open(keeping: Bool) {
        opening = true
        openingNeed = nil
        unkept = nil
        Task {
            if keeping {
                let watching = Task { await watchDoor() }
                let kept = await keeper.keep(within: keepWithin)
                watching.cancel()
                switch kept {
                case .kept: break
                case .notKept(let why): unkept = .refused(why)
                case .notOpened: unkept = .waited(Self.notOpened(held: openingNeed, after: keepWithin))
                }
            }
            if unkept == nil {
                await restartDoor()
                await served()
            } else {
                _ = await asked()
            }
            await read()
            opening = false
            openingNeed = nil
        }
    }

    private func watchDoor() async {
        while !Task.isCancelled {
            let answer = await asked()
            if !Task.isCancelled { openingNeed = answer.need }
            try? await Task.sleep(for: doorPace)
        }
    }

    private func served() async {
        for _ in 0..<Self.doorTries {
            let answer = await asked()
            openingNeed = answer.need
            if answer == .serves { return }
            if answer == .locked, !(await keeper.keyTrusted()) { return }
            try? await Task.sleep(for: doorPace)
        }
    }

    func opened(_ need: Need) {
        guard !working.contains(need.id) else { return }
        refusals[need.id] = nil
    }

    func type(_ text: String, for need: Need) {
        drafts[need.id] = text
    }

    func forget() {
        drafts = [:]
    }

    func save(_ need: Need, secret: String) {
        guard case .password = need else { return }
        let id = need.id
        let value = drafts[id] ?? ""
        act(id) { [weak self, keeper] in
            guard !value.isEmpty else { return "Type the password first." }
            self?.saved.remove(id)
            do {
                try await keeper.save(secret: secret, value: value)
                self?.drafts[id] = nil
                self?.saved.insert(id)
                return nil
            } catch {
                return Self.said(error, else: "Lifestream couldn't save the password. Try again.")
            }
        }
    }

    static func said(_ error: Error, else plain: String) -> String {
        refusal(error, else: plain).words
    }

    static func sentence(_ words: String) -> String {
        guard let first = words.first else { return words }
        let capital = first.uppercased() + words.dropFirst()
        return ".!?".contains(capital.last!) ? capital : capital + "."
    }

    static func refusal(_ error: Error, else plain: String) -> HostRefusal {
        guard let refusal = error as? VaultRefusal else { return HostRefusal(plain) }
        if let socket = refusal.socket, let said = MacHost.said(socket) as? HostRefusal { return said }
        return HostRefusal(refusal.words ?? plain)
    }

    func seal(_ secret: String, _ value: String?) async throws {
        do {
            try await keeper.save(secret: secret, value: value)
        } catch {
            throw Self.refusal(error, else: "Lifestream couldn't save that on this Mac. Try again.")
        }
        await knock()
        await read()
    }

    @discardableResult
    func retry() -> Task<String?, Never>? {
        act("update") { [weak self] in
            let failure = await self?.retryUpdate()
            self?.updated(failure)
            return failure?.words
        }
    }

    @discardableResult
    private func act(_ id: String, _ work: @escaping @MainActor () async -> String?) -> Task<String?, Never>? {
        guard !working.contains(id) else { return nil }
        working.insert(id)
        refusals[id] = nil
        return Task {
            let refusal = await work()
            refusals[id] = refusal
            working.remove(id)
            if refusal == nil { await knock() }
            await read()
            return refusal
        }
    }

    private func recompute() {
        let now = Needs.list(vault: vault, keyMayOpen: keyHeld && opensNot != vault?.keyID, update: update, ready: ready, needs: home,
                             files: files)
        let ids = now.map(\.id)
        let begun = watch.began(ids)
        if !saved.isSubset(of: ids) { saved.formIntersection(ids) }
        if drafts.keys.contains(where: { !ids.contains($0) }) { drafts = drafts.filter { ids.contains($0.key) } }
        guard now != list else { return }
        let before = Set(list.map(\.id))
        list = now
        changed?()
        if begun { began?(now.filter { !before.contains($0.id) }) }
    }
}
