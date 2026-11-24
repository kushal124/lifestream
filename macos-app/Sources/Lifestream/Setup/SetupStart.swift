import AppKit
import Foundation
import HomeLink
import Passwords
import Shipping

struct Drafted: Decodable, Sendable, CustomStringConvertible {
    let recovery: String
    let slot: String
    let number: Int
    let made_ms: Int64

    var description: String { "recovery key \(number), slot \(slot)" }

    func handoff(home: String, slotKey: Data) throws -> Data {
        var line = try JSONSerialization.data(withJSONObject: ["home_id": home, "slot_key": slotKey.map { String(format: "%02x", $0) }.joined(),
                                                               "recovery": recovery])
        line.append(10)
        return line
    }
}

typealias ShowKey = @MainActor @Sendable (_ drafted: Drafted, _ folder: URL) async -> Bool

struct KeyedSteps: Sendable {
    var trust: @Sendable (_ home: String) -> Void
    var make: @Sendable (_ folder: URL) throws -> (home: String, key: Data)
    var draft: @Sendable () throws -> Drafted
    var adopt: @Sendable (_ folder: String, _ handed: Data) throws -> Void
    var adopted: @Sendable (_ home: String, _ folder: URL) -> Void

    static func live(_ release: BundledRelease, keys: HomeKeys = HomeKeys(reader: .app)) -> KeyedSteps {
        KeyedSteps(
            trust: { home in _ = try? keys.keyed(home).read() },
            make: { folder in try keys.newHome(in: folder) },
            draft: { try release.draft() },
            adopt: { folder, handed in _ = try release.home(StartSteps.adoptArguments(folder) + ["--keyed"], handing: handed) },
            adopted: { home, folder in keys.adopted(home, in: folder) })
    }
}

struct StartSteps: Sendable {
    var world: @Sendable () -> (folder: URL?, release: Bool, paired: Bool)
    var adopt: @Sendable (_ folder: String) throws -> Void
    var keyed: KeyedSteps
    var install: @Sendable () throws -> Void
    var command: @Sendable () -> Void
    var agents: @Sendable () async throws -> Void
    var loginWaits: @Sendable () -> Bool
    var answers: @Sendable (_ door: String, _ within: TimeInterval) async -> DoorAnswer
    var locked: @MainActor @Sendable () async -> Void = {}
    var passRefused: @Sendable () async -> Bool = { false }
    var mintCode: @Sendable () throws -> String
    var name: @Sendable (_ name: String) async throws -> Void
    var logTail: @Sendable () -> String
    var answerWithin: TimeInterval = 120
    var askEvery: Duration = .seconds(1)
    var now: @Sendable () -> Date = { Date() }
    var sleep: @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }

    static func live(_ release: BundledRelease, dashboard: URL, link: @escaping @Sendable () -> HomeLink?,
                     locked: @escaping @MainActor @Sendable () async -> Void = {}) -> StartSteps {
        StartSteps(
            world: {
                let world = SetupWorld.read(link: link())
                return (world.folder, world.release, world.paired)
            },
            adopt: { folder in _ = try release.home(adoptArguments(folder)) },
            keyed: .live(release),
            install: { _ = try release.home(["install"]) },
            command: { HomeAgents.keepCommand(release) },
            agents: { _ = try await HomeAgents.reconcile() },
            loginWaits: {
                HomeAgents.openAtLogin()
                return HomeAgents.awaitingApproval
            },
            answers: { door, within in
                if let unheard = await HomeSocket.blocking({ homeAnswers(HomeSocket.thisMac()) }) { return unheard }
                let answer = await DoorAnswer.asked(URL(string: door), within: within)
                guard answer == .serves else { return answer }
                let page = try? await URLSession.shared.data(for: URLRequest(url: dashboard, timeoutInterval: max(1, within)))
                return page?.1 is HTTPURLResponse ? .serves : .silent
            },
            locked: locked,
            passRefused: {
                guard let link = link() else { return false }
                return await passRefused(link)
            },
            mintCode: {
                guard let socket = HomeSocket.thisMac() else { throw ReleaseError(words: "this Mac points at no Lifestream folder") }
                guard let answer = try socket.ask(["verb": "pair", "args": ConnectorsHome.pairArgs(appleID: ShippingDomains.appleID())]) as? [String: Any],
                      let code = answer["code"] as? String else { throw ReleaseError(words: "Lifestream made no pairing code") }
                return code
            },
            name: { name in
                guard let socket = HomeSocket.thisMac(), let unit = link()?.unit else {
                    throw ReleaseError(words: "this Mac is not paired yet")
                }
                try await ConnectorsHome(socket: socket).name(unit: unit, as: name)
            },
            logTail: { SetupStart.logTail() })
    }
}

extension StartSteps {
    static func homeAnswers(_ socket: HomeSocket?) -> DoorAnswer? {
        do {
            guard let socket else { return .silent }
            _ = try socket.ask(["verb": "settings", "args": [String]()])
            return nil
        } catch HomeSocketError.refused(let refusal) where refusal.code == DoorAnswer.lockedCode {
            return .locked
        } catch {
            return .silent
        }
    }

    static func passRefused(_ link: HomeLink) async -> Bool {
        do {
            _ = try await link.status()
            return false
        } catch LinkFailure.refused(status: 401, _, _) {
            return true
        } catch {
            return false
        }
    }

    static func adoptArguments(_ folder: String) -> [String] {
        let device = MacLink.device()
        return ["adopt", folder, "--model", device.model] + (device.serial4.map { ["--serial4", $0] } ?? [])
    }
}

enum DoorAnswer: Equatable, Sendable {
    case serves
    case notNow(String, retryAfter: TimeInterval?, starting: Bool)
    case locked
    case silent

    static let notNowCode = "NOT_NOW"
    static let lockedCode = "LOCKED"

    init(status: Int, body: Data, retryAfter: String?) {
        let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        switch (status, object?["code"] as? String) {
        case (503, Self.lockedCode?):
            self = .locked
        case (503, Self.notNowCode?):
            self = .notNow(object?["message"] as? String ?? "", retryAfter: retryAfter.flatMap { TimeInterval($0.trimmingCharacters(in: .whitespaces)) },
                           starting: object?["wait"] as? String == "starting")
        default:
            self = .serves
        }
    }

    static func asked(_ door: URL?, within: TimeInterval) async -> DoorAnswer {
        guard let url = door?.appendingPathComponent("v1/status"),
              let (body, response) = try? await URLSession.shared.data(for: URLRequest(url: url, timeoutInterval: max(1, within))),
              let status = response as? HTTPURLResponse else { return .silent }
        return DoorAnswer(status: status.statusCode, body: body, retryAfter: status.value(forHTTPHeaderField: "Retry-After"))
    }

    var need: String? {
        if case .notNow(let words, _, starting: false) = self, !words.isEmpty { return words }
        return nil
    }
}

final class DoorAddress: @unchecked Sendable {
    private let named: @Sendable () -> URL?
    private let pointed: @Sendable () -> URL?
    private let looked: @Sendable (URL) -> URL?
    private let lock = NSLock()
    private var learned: (folder: URL, door: URL)?

    init(named: @escaping @Sendable () -> URL?, pointed: @escaping @Sendable () -> URL?, looked: @escaping @Sendable (URL) -> URL?) {
        self.named = named
        self.pointed = pointed
        self.looked = looked
    }

    func url() -> URL? {
        if let named = named() { return named }
        guard let folder = pointed() else { return nil }
        if let learned = lock.withLock({ learned }), learned.folder == folder { return learned.door }
        guard let door = looked(folder) else { return nil }
        lock.withLock { learned = (folder, door) }
        return door
    }
}

@MainActor final class SetupStart: ObservableObject {
    enum Phase: Equatable {
        case idle
        case running
        case starting(String)
        case loginItems
        case locked
        case refused(String)
        case failed(details: String)
        case done
    }

    nonisolated static let logLines = 8

    @Published private(set) var phase: Phase

    enum Paired: Equatable, Sendable {
        case paired
        case notNow(String, retryAfter: TimeInterval?, starting: Bool)
        case refused(String)

        init(failed error: any Error) {
            guard let failure = error as? LinkFailure else {
                self = .refused("\(error)")
                return
            }
            if case .unavailable(DoorAnswer.notNowCode, let message, let retryAfter, let kind) = failure {
                let starting = if case .starting = kind { true } else { false }
                self = .notNow(message ?? "", retryAfter: retryAfter, starting: starting)
            } else {
                self = .refused(HostRefusal(failure).words)
            }
        }
    }

    private let pair: (_ name: String, _ code: String) async -> Paired
    private var running: Task<Void, Never>?

    init(pair: @escaping (_ name: String, _ code: String) async -> Paired, phase: Phase = .idle) {
        self.pair = pair
        self.phase = phase
    }

    func begin(_ steps: StartSteps, folder: URL, door: String, name: String, home: FolderHome, show: @escaping ShowKey) {
        guard running == nil else { return }
        phase = .running
        running = Task { @MainActor in
            phase = await start(steps, folder: folder, door: door, name: name, home: home, show: show)
            running = nil
        }
    }

    func run(_ steps: StartSteps, folder: URL, door: String, name: String, home: FolderHome = .plain,
             show: @escaping ShowKey = { _, _ in false }) async {
        begin(steps, folder: folder, door: door, name: name, home: home, show: show)
        await running?.value
    }

    func cannotBegin(_ why: String) {
        guard running == nil else { return }
        phase = .failed(details: why)
    }

    func passForgotten() {
        guard running == nil, phase == .done else { return }
        phase = .idle
    }

    func folderChanged() {
        if case .refused = phase { phase = .idle }
    }

    private func start(_ steps: StartSteps, folder: URL, door: String, name: String, home: FolderHome, show: ShowKey) async -> Phase {
        phase = .running
        let path = folder.path
        let world = await Task.detached { steps.world() }.value
        if world.folder?.path != path {
            do {
                switch home {
                case .plain:
                    try await Task.detached { try steps.adopt(path) }.value
                case .encrypted(let id):
                    await Task.detached { steps.keyed.trust(id) }.value
                    try await Task.detached { try steps.adopt(path) }.value
                case .new:
                    guard try await adoptKeyed(steps.keyed, folder: folder, show: show) else { return .idle }
                }
            } catch {
                return .refused("\(error)")
            }
        }
        do {
            if !world.release {
                try await Task.detached { try steps.install() }.value
                await Task.detached { steps.command() }.value
            }
            try await Task.detached { try await steps.agents() }.value
        } catch {
            return await failed("\(error)", steps)
        }
        if await Task.detached(operation: { steps.loginWaits() }).value { return .loginItems }
        var deadline = steps.now().addingTimeInterval(steps.answerWithin)
        var code: String?
        var heard: (words: String, starting: Bool)?
        pairing: while true {
            if let stopped = await served(steps, door: door, until: &deadline, heard: heard) { return stopped }
            if await Task.detached(operation: { steps.world().paired }).value, !(await steps.passRefused()) { break }
            let made: String
            if let code {
                made = code
            } else {
                do {
                    made = try await HomeSocket.blocking { Result { try steps.mintCode() } }.get()
                } catch {
                    return await failed("\(error)", steps)
                }
                code = made
            }
            switch await pair(door, made) {
            case .paired: break pairing
            case .refused(let words): return await failed(words, steps)
            case .notNow(let words, let retryAfter, let starting):
                heard = (words, starting)
                phase = .starting(words)
                await steps.sleep(Self.pause(retryAfter, steps, deadline))
            }
        }
        do {
            try await steps.name(name)
        } catch {
            return await failed("This Mac's name was not kept: \(error)", steps)
        }
        return .done
    }

    private func adoptKeyed(_ keyed: KeyedSteps, folder: URL, show: ShowKey) async throws -> Bool {
        let path = folder.path
        let drafted = try await Task.detached { try keyed.draft() }.value
        guard await show(drafted, folder) else { return false }
        try await Task.detached {
            let made: (home: String, key: Data)
            do {
                made = try keyed.make(folder)
            } catch {
                throw ReleaseError(words: "Lifestream couldn't keep its key in your Mac's Keychain: \(error). Nothing was made, so the recovery key you saved opens nothing.")
            }
            try keyed.adopt(path, try drafted.handoff(home: made.home, slotKey: made.key))
            keyed.adopted(made.home, folder)
        }.value
        return true
    }

    private func served(_ steps: StartSteps, door: String, until deadline: inout Date, heard: (words: String, starting: Bool)?) async -> Phase? {
        var heard = heard
        while steps.now() < deadline {
            let answer = await steps.answers(door, deadline.timeIntervalSince(steps.now()))
            if answer == .locked {
                if phase != .locked {
                    phase = .locked
                    await steps.locked()
                }
                deadline = steps.now().addingTimeInterval(steps.answerWithin)
                await steps.sleep(steps.askEvery)
                continue
            }
            guard steps.now() < deadline else { break }
            switch answer {
            case .serves:
                phase = .running
                return nil
            case .notNow(let words, let retryAfter, let starting):
                heard = (words, starting)
                phase = .starting(words)
                await steps.sleep(Self.pause(retryAfter, steps, deadline))
            case .silent, .locked:
                await steps.sleep(steps.askEvery)
            }
        }
        let within = Int(steps.answerWithin)
        guard heard?.starting == true else { return await failed("Lifestream did not answer within \(within) seconds.", steps, door: heard?.words) }
        return await failed("Lifestream did not finish starting within \(within) seconds.", steps, door: heard?.words)
    }

    private nonisolated static func pause(_ retryAfter: TimeInterval?, _ steps: StartSteps, _ deadline: Date) -> Duration {
        let stated = retryAfter.map { Duration.seconds(max(0, $0)) } ?? steps.askEvery
        return min(stated, .seconds(max(0, deadline.timeIntervalSince(steps.now()))))
    }

    private func failed(_ words: String, _ steps: StartSteps, door: String? = nil) async -> Phase {
        let logs = await Task.detached { steps.logTail() }.value
        return .failed(details: "\(words)\n\n" + (door.map { "The door said: \($0)\n\n" } ?? "") + logs)
    }

    nonisolated static func logTail(home: URL = Launcher.log(.home), door: URL = Launcher.log(.door)) -> String {
        [home, door].map { url in
            let lines = tail(url).map { $0.isEmpty ? "(empty)" : $0 } ?? "(no log yet)"
            return "\(url.lastPathComponent):\n\(lines)"
        }.joined(separator: "\n\n")
    }

    nonisolated static func tail(_ url: URL, lines count: Int = logLines) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        let end = (try? handle.seekToEnd()) ?? 0
        try? handle.seek(toOffset: end > 16_384 ? end - 16_384 : 0)
        let text = String(decoding: handle.readDataToEndOfFile(), as: UTF8.self)
        return text.split(separator: "\n", omittingEmptySubsequences: true).suffix(count).joined(separator: "\n")
    }
}
