import DeviceFiles
import Evidence
import Foundation
import Recorder
import Shipping

@MainActor enum ModeCommands {
    static func modes(_ options: Options, settings file: URL = MacLink.settingsFile,
                      files opened: @autoclosure () throws -> DeviceFiles) async throws -> CommandOutcome {
        let ownership: RecorderControlServer
        do {
            ownership = try RecorderControlServer(directory: options.directory) { _ in
                ControlResponse(ok: false, state: "setting_modes", message: "Wait for the modes command to finish")
            }
        } catch RecorderControlError.alreadyRunning {
            return try await ask(options)
        }
        defer { ownership.close() }
        let files = try opened()
        let copy = RecordingModes.load(from: options.directory, files: files) { line in
            FileHandle.standardError.write(Data((line + "\n").utf8))
        }
        let settings = MacSettings(file: file, defaults: ScreenSettings.defaults(options, modes: copy), files: files)
        var modes = settings.value("screen", "apps").flatMap { AppsField.modes($0, current: copy) } ?? copy
        if let change = options.modeChange {
            try settings.seed("screen", "apps", local: AppsField.of(copy))
            modes = settings.value("screen", "apps").flatMap { AppsField.modes($0, current: copy) } ?? copy
            switch change.target {
            case .app(let bundleID): try modes.set(change.mode, for: bundleID)
            case .site(let rule): try modes.setSite(change.mode, for: rule)
            }
            try settings.set("screen", "apps", to: AppsField.of(modes))
            try modes.save(to: options.directory, files: files)
        }
        try writeJSONLine(modes.listing)
        return .succeeded
    }

    private static func ask(_ options: Options) async throws -> CommandOutcome {
        var request = ControlRequest(action: Command.modes.rawValue, mode: options.modeChange?.mode.rawValue)
        switch options.modeChange?.target {
        case .app(let bundleID)?: request.bundleID = bundleID
        case .site(let rule)?: request.site = rule
        case nil: break
        }
        let response = try await RecorderControlClient.call(directory: options.directory, request: request)
        guard response.ok, let modes = response.modes else {
            throw UsageError.message(response.message ?? "The app did not change the recording modes")
        }
        try writeJSONLine(modes)
        return .succeeded
    }
}
