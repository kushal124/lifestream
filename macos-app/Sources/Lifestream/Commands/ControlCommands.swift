import Foundation
import Recorder

@MainActor enum ControlCommands {
    static func send(_ options: Options) async throws -> CommandOutcome {
        let action = options.command == .liveStatus ? "status" : options.command.rawValue
        let request = ControlRequest(action: action, durationSeconds: options.duration)
        let response = try await RecorderControlClient.call(directory: options.directory, request: request)
        try writeJSONLine(response)
        return response.ok ? .succeeded : .failed
    }
}
