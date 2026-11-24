import AppKit
import Foundation
import Passwords

@MainActor final class RecoveryKey: ObservableObject {
    enum Face: Equatable {
        case reading
        case making
        case shown
        case savedKey(KeyName?)
        case saved(KeyName, replaced: KeyName?)
        case allow
        case lost
        case noHome
        case check
    }

    enum Door: Equatable {
        case asked, lost
    }

    struct Shown: Equatable {
        let key: String
        let name: KeyName
    }

    enum Used: Equatable {
        case saved, copied
    }

    enum Discarded: Equatable {
        case atHome, owed
    }

    @Published private(set) var face = Face.reading
    @Published private(set) var shown: Shown?
    @Published private(set) var used: Used?
    @Published private(set) var said: String?
    @Published private(set) var refusal: HostRefusal?
    @Published private(set) var working = false
    @Published private(set) var confirming = false
    @Published private(set) var elsewhere: [String] = []
    @Published private(set) var checked: RecoveryCheck?
    @Published var leaving = false

    static let unheard = "Lifestream stopped answering, so it may have started the new vault. If your passwords show as open, make a new recovery key and save it."
    static let toGoOn = "Save it as a file, or copy it, to go on."
    static let copied = "Copied. Paste it into your password manager within 90 seconds."
    static let learnMore = URL(string: "https://trylifestream.com/keep-your-data-safe/")!
    static let owedKey = "recoveryKeyDiscardOwed"

    weak var needs: NeedsModel?
    var names: ([String]) async -> [String] = { $0 }
    var choose: (String) async -> URL? = { await RecoveryKeyFile.choose($0, over: nil) }
    var folder: () -> URL? = { SetupWorld.pointed() }
    var board = NSPasteboard.general
    var later = SecretCopy.wallClock

    private let keeper: VaultKeeper
    private let defaults: UserDefaults
    private var settling: Task<Void, Never>?
    private var forgotten = 0
    private var previous: KeyName?
    private var waiting: Door?

    init(keeper: VaultKeeper, defaults: UserDefaults = .standard) {
        self.keeper = keeper
        self.defaults = defaults
    }

    var owesDiscard: Bool { defaults.bool(forKey: Self.owedKey) }

    var asksBeforeClosing: Bool { shown != nil && used != nil }

    var keyed: Bool { needs?.vault?.keyed == true }
    var opens: String { keyed ? "Lifestream" : "your passwords" }

    func checking() {
        guard shown == nil, !working else { return }
        refusal = nil
        checked = nil
        face = .check
    }

    func check(_ typed: String) async {
        guard face == .check, !working else { return }
        guard !typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            refusal = HostRefusal("Type the recovery key first.")
            return
        }
        working = true
        refusal = nil
        checked = nil
        let mine = forgotten
        let outcome: Result<RecoveryCheck, HostRefusal>
        do {
            outcome = .success(try await keeper.check(typed))
        } catch {
            outcome = .failure(NeedsModel.refusal(error, else: "Lifestream couldn't check the recovery key. Try again."))
        }
        working = false
        guard mine == forgotten, face == .check else { return }
        switch outcome {
        case .success(let answer): checked = answer
        case .failure(let refused): refusal = refused
        }
    }

    func checkedLine(_ answer: RecoveryCheck) -> String {
        let name = KeyName(number: answer.number, madeMs: answer.madeMs)
        return answer.opens ? "\(name.title), made on \(name.day), opens \(opens)."
                            : "This key doesn't open \(opens). Your saved key is \(name.inLine)."
    }

    func open(_ door: Door) async {
        guard shown == nil else { return }
        guard !working else {
            waiting = door
            return
        }
        let mine = forgotten
        face = .reading
        refusal = nil
        said = nil
        await needs?.read()
        let named = await names(needs?.elsewhere ?? [])
        guard mine == forgotten, shown == nil, !working else { return }
        elsewhere = named
        previous = needs?.vault?.saved.flatMap(KeyName.init)
        face = door == .lost ? .lost : Self.face(needs?.vault, reached: needs?.reached ?? false, need: needs?.vaultNeed)
        if face == .making { await make() }
    }

    static func face(_ vault: VaultState?, reached: Bool, need: Need?) -> Face {
        guard reached, let vault else { return .noHome }
        switch need {
        case .allow?, .homeLocked(allow: true)?: return .allow
        case .unlock?, .homeLocked(allow: false)?: return .lost
        default: break
        }
        guard vault.keyID != nil, vault.recovery == .confirmed else { return .making }
        return .savedKey(vault.saved.flatMap(KeyName.init))
    }

    @discardableResult
    func make(newVault: Bool = false) async -> Bool {
        guard !working, shown == nil else { return false }
        working = true
        refusal = nil
        said = nil
        if !newVault { face = .making }
        let mine = forgotten
        await settling?.value
        let outcome: Result<RecoveryMade?, HostRefusal>
        do {
            if !newVault {
                outcome = .success(try await keeper.makeRecoveryKey())
            } else if case .made(let made) = try await keeper.startNewVault() {
                outcome = .success(made)
            } else {
                outcome = .success(nil)
            }
        } catch {
            outcome = .failure(Self.refusal(error, newVault: newVault))
        }
        working = false
        if mine == forgotten {
            waiting = nil
            switch outcome {
            case .success(let made?):
                if newVault { previous = nil }
                shown = Shown(key: made.key, name: KeyName(made))
                used = nil
                face = .shown
            case .success(nil):
                break
            case .failure(let refused):
                refusal = refused
                if refused.said == .notSent { face = .noHome }
            }
        }
        await needs?.read()
        if mine != forgotten, let door = waiting {
            waiting = nil
            await open(door)
        }
        return mine == forgotten && shown != nil
    }

    func startNewVault() async {
        guard !keyed else { return }
        let made = await make(newVault: true)
        if !made, refusal == nil { await open(.asked) }
    }

    func allow() async {
        guard let task = needs?.allow() else { return }
        if let refused = await task.value {
            refusal = HostRefusal(refused)
        } else {
            await open(.asked)
        }
    }

    private static func refusal(_ error: Error, newVault: Bool) -> HostRefusal {
        guard newVault else { return NeedsModel.refusal(error, else: "Lifestream couldn't make a recovery key. Try again.") }
        if (error as? VaultRefusal)?.homeMayHaveActed == true { return HostRefusal(unheard) }
        return NeedsModel.refusal(error, else: "Lifestream couldn't start a new vault. Try again.")
    }

    func copy() {
        guard let shown else { return }
        SecretCopy.put(shown.key, on: board, later: later)
        if used == nil { used = .copied }
        said = Self.copied
    }

    func save() async {
        guard let asked = shown, !working else { return }
        guard let file = await choose(RecoveryKeyFile.name(asked.name)), shown == asked else { return }
        switch RecoveryKeyFile.save(asked.key, name: asked.name, keyed: keyed, to: file, folder: folder()) {
        case .saved(let name):
            used = .saved
            said = "Saved to \(name)."
        case .refused(let words):
            said = words
        }
    }

    func discard(sending: Bool = true) async -> Discarded? {
        guard shown != nil, !working else { return nil }
        guard sending else { return owed() }
        working = true
        refusal = nil
        let mine = forgotten
        do {
            try await keeper.discard()
        } catch {
            working = false
            if (error as? VaultRefusal)?.socket?.reach == true { return owed() }
            if mine == forgotten { refusal = NeedsModel.refusal(error, else: notDiscarded) }
            return nil
        }
        working = false
        forget()
        await needs?.read()
        return .atHome
    }

    private func owed() -> Discarded {
        defaults.set(true, forKey: Self.owedKey)
        forget()
        return .owed
    }

    func settle() async {
        if let settling { return await settling.value }
        guard owesDiscard, shown == nil, !working else { return }
        let sending = Task {
            if (try? await keeper.discard()) != nil { defaults.removeObject(forKey: Self.owedKey) }
        }
        settling = sending
        await sending.value
        settling = nil
    }

    var notDiscarded: String { "Lifestream couldn't discard this key, so it still opens \(opens). Try again." }
    var owedWords: String { "This key still opens \(opens) until Lifestream answers again. This Mac discards it then." }

    @discardableResult
    func confirm() async -> Bool {
        guard let kept = shown, used != nil, !working else { return false }
        working = true
        confirming = true
        refusal = nil
        let mine = forgotten
        var outcome: HostRefusal?
        do {
            try await keeper.confirm(kept.key)
        } catch {
            outcome = NeedsModel.refusal(error, else: "Lifestream couldn't check the recovery key. Try again.")
            await needs?.read()
            if Self.confirmed(kept.name, in: needs?.vault) { outcome = nil }
        }
        working = false
        confirming = false
        guard mine == forgotten else {
            if let door = waiting {
                waiting = nil
                await open(door)
            }
            return false
        }
        waiting = nil
        if let outcome {
            refusal = outcome
            return false
        }
        face = .saved(kept.name, replaced: previous == kept.name ? nil : previous)
        previous = kept.name
        shown = nil
        used = nil
        said = nil
        await needs?.knock()
        await needs?.read()
        return true
    }

    static func confirmed(_ name: KeyName, in vault: VaultState?) -> Bool {
        vault?.recoveries.contains { $0.confirmedMs != nil && KeyName($0) == name } ?? false
    }

    func forget() {
        forgotten += 1
        if shown != nil { shown = nil }
        if used != nil { used = nil }
        if said != nil { said = nil }
        if refusal != nil { refusal = nil }
        if checked != nil { checked = nil }
        waiting = nil
        face = .reading
    }
}
