import Foundation

enum AgentCommands {
    static func launch(_ options: Options) throws -> CommandOutcome {
        guard let job = options.job else { throw UsageError.message("Pass --job home, door, dashboard, mcp or runner") }
        Launcher.exec(job)
    }

    static func agents(_ options: Options) async throws -> CommandOutcome {
        if let folder = options.outputURL {
            try HomeJob.writeDefinitions(into: folder)
            return .succeeded
        }
        var failure: String?
        do {
            switch options.agentsOn {
            case true?: _ = try await HomeAgents.reconcile()
            case false?: try await HomeAgents.remove()
            case nil: break
            }
        } catch {
            failure = "\(error)"
        }
        let states = await Task.detached { HomeAgents.states() }.value
        var line = Dictionary(uniqueKeysWithValues: states.map { ($0.key.rawValue, $0.value.rawValue) })
        line["app"] = HomeAgents.appLogin.rawValue
        if let failure { line["refused"] = failure }
        try writeJSONLine(line)
        return failure == nil ? .succeeded : .failed
    }

    static func setup() async throws -> CommandOutcome {
        let (world, app) = await Task.detached { (SetupWorld.read(link: MacLink.shared), HomeAgents.appLogin) }.value
        try writeJSONLine(SetupLine(world, app: app))
        return .succeeded
    }

    private struct SetupLine: Encodable {
        let opens: String?
        let release: Bool
        let folder: String?
        let agents: [String: String]
        let paired: Bool
        let app: HomeAgents.AppLogin

        init(_ world: SetupWorld, app: HomeAgents.AppLogin) {
            opens = world.opensAt?.rawValue
            release = world.release
            folder = world.folder?.path
            agents = Dictionary(uniqueKeysWithValues: world.agents.map { ($0.key.rawValue, $0.value.rawValue) })
            paired = world.paired
            self.app = app
        }

        enum CodingKeys: String, CodingKey {
            case opens, release, folder, agents, paired, app
        }

        func encode(to encoder: Encoder) throws {
            var fields = encoder.container(keyedBy: CodingKeys.self)
            try fields.encode(opens, forKey: .opens)
            try fields.encode(release, forKey: .release)
            try fields.encode(folder, forKey: .folder)
            try fields.encode(agents, forKey: .agents)
            try fields.encode(paired, forKey: .paired)
            try fields.encode(app, forKey: .app)
        }
    }
}
