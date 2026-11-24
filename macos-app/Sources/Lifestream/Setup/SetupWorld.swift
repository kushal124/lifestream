import Foundation
import HomeLink
import Passwords

enum FirstRun: String, Equatable {
    case move, welcome

    var hash: String { "view=onboarding&seg=\(self == .move ? "place" : "welcome")" }
}

struct SetupWorld: Equatable, Sendable {
    let placed: Bool
    let release: Bool
    let outdated: Bool
    let folder: URL?
    let agents: [HomeJob: HomeAgents.State]
    let paired: Bool

    var agentsRun: Bool { HomeJob.allCases.allSatisfy { agents[$0] == .current } }

    var running: Bool { release && agentsRun }

    var opensAt: FirstRun? {
        guard placed else { return .move }
        guard folder != nil, running, paired else { return .welcome }
        return nil
    }

    var setUp: Bool { placed && paired }

    static func outdated(current: ReleaseStamp?, carried: ReleaseStamp?) -> Bool {
        guard let carried else { return false }
        guard let current else { return true }
        return carried.isNewer(than: current)
    }

    static func paired(_ link: HomeLink?, folderHome: String?) -> Bool {
        guard let link else { return true }
        return paired(holdsPass: (try? link.name()) != nil, passHome: link.saved?.home.id, folderHome: folderHome)
    }

    static func paired(holdsPass: Bool, passHome: String?, folderHome: String?) -> Bool {
        guard holdsPass else { return false }
        guard let passHome, let folderHome else { return true }
        return passHome == folderHome
    }

    static func pointed() -> URL? { HomeSocket.folder() }

    static func read(link: HomeLink?, carried: BundledRelease? = .inApp(), bundle: URL = Bundle.main.bundleURL) -> SetupWorld {
        let folder = pointed()
        let folderHome = json(folder?.appendingPathComponent("HOME.json"))?["id"] as? String
        let agents = HomeAgents.states()
        let current = ReleaseStamp(manifest: MachineDirectory.current)
        return SetupWorld(placed: carried != nil && HomeAgents.placeRefusal(bundle) == nil,
                          release: Launcher.command(.home) != nil,
                          outdated: outdated(current: current, carried: carried?.stamp),
                          folder: folder, agents: agents,
                          paired: paired(link, folderHome: folderHome))
    }

    private static func json(_ url: URL?) -> [String: Any]? {
        url.flatMap { try? Data(contentsOf: $0) }.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
    }

    static func heal(link: HomeLink?, bundle: URL = Bundle.main.bundleURL) async -> UpdateFailure? {
        guard HomeAgents.placeRefusal(bundle) == nil else { return nil }
        var world = await Task.detached { read(link: link) }.value
        guard world.folder != nil else { return nil }
        let deadline = Date().addingTimeInterval(HomeAgents.firstTryWithin)
        while Date() < deadline {
            try? await Task.sleep(for: HomeAgents.settle)
            let again = await Task.detached { read(link: link) }.value
            defer { world = again }
            if again.agents == world.agents, !again.agents.values.contains(.starting) { break }
        }
        if let refusal = HomeAgents.foreignRefusal(world.agents) { return world.release ? .blocked(refusal) : nil }
        _ = try? await HomeAgents.reconcile(bundle: bundle)
        if world.release { Task.detached(priority: .utility) { HomeAgents.keepCommand() } }
        guard world.outdated else { return nil }
        let failure = await update()
        return world.release ? failure.map(UpdateFailure.refused) : nil
    }

    static let installLog = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/lifestream/install.log")

    static func update(carried: BundledRelease? = .inApp(), machine: URL = MachineDirectory.url, log: URL = installLog) async -> String? {
        guard let carried, let stamp = carried.stamp,
              outdated(current: ReleaseStamp(manifest: machine.appendingPathComponent("current/RELEASE.json")), carried: stamp) else { return nil }
        let outcome: (key: String, value: Any, words: String?)
        do {
            let result = try await Task.detached { try carried.home(["install"]) }.value
            outcome = ("installed", (try? JSONSerialization.jsonObject(with: result)) ?? String(decoding: result, as: UTF8.self), nil)
        } catch {
            outcome = ("refused", "\(error)", "\(error)")
        }
        let line: [String: Any] = ["at": ISO8601DateFormatter().string(from: Date()), "release": stamp.commit, outcome.key: outcome.value]
        if var data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys, .withoutEscapingSlashes]) {
            data.append(0x0A)
            await Task.detached { [data] in OwnLog.append(data, to: log) }.value
        }
        return outcome.words
    }
}
