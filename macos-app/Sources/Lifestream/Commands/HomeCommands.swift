import Foundation
import HomeLink
import Recorder
import Shipping

@MainActor enum HomeCommands {
    static func home(_ options: Options) async throws -> CommandOutcome {
        guard let code = options.pairingCode else {
            if options.homeName != nil { throw UsageError.message("Pass --code with --name") }
            try writeJSONLine(try line(try MacLink.opened()))
            return .succeeded
        }
        guard let name = options.homeName else { throw UsageError.message("Pass --name with --code") }
        let response: ControlResponse
        do {
            response = try await RecorderControlClient.call(directory: options.directory, request: ControlRequest(action: "pair", name: name, code: code))
        } catch RecorderControlError.unavailable {
            throw UsageError.message(appClosedWords)
        }
        return try answered(response)
    }

    static let appClosedWords = "Open Lifestream, then run this again: this Mac pairs through the app."

    static func pair(name: String, code: String, link: HomeLink) async -> ControlResponse {
        do {
            _ = try await link.pair(code: code, name: name, offers: [])
            return ControlResponse(ok: true, state: "paired", home: try line(link))
        } catch {
            return ControlResponse(ok: false, state: "error", message: "\(error)")
        }
    }

    private static func answered(_ response: ControlResponse) throws -> CommandOutcome {
        guard response.ok, let home = response.home else {
            throw UsageError.message(response.message ?? "The app did not pair this Mac")
        }
        try writeJSONLine(home)
        return .succeeded
    }

    private static func line(_ link: HomeLink) throws -> ControlHome {
        let name: URL?
        do { name = try link.name() } catch { throw UsageError.message("\(error)") }
        return ControlHome(home: name?.absoluteString, pass: name == nil ? "unset" : "set", unit: name == nil ? nil : link.saved?.unit)
    }
}
