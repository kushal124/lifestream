import Evidence
import Foundation
import Recorder
import Screen

@main
struct LifestreamMain {
    @MainActor static func main() async {
        do {
            let options = try Options(Array(CommandLine.arguments.dropFirst()))
            if try await run(options) == .failed { exit(1) }
        } catch {
            FileHandle.standardError.write(Data((message(for: error) + "\n").utf8))
            exit(1)
        }
    }

    @MainActor private static func run(_ options: Options) async throws -> CommandOutcome {
        if let process = options.command.process { MacProcess.start(process, spool: options.directory) }
        switch options.command {
        case .help:
            print(Command.usage)
            return .succeeded
        case .start, .pause, .liveStatus, .shutdown, .ship:
            return try await ControlCommands.send(options)
        case .home:
            return try await HomeCommands.home(options)
        case .modes:
            return try await ModeCommands.modes(options, files: try MacProcess.current.writing())
        case .status:
            return try SpoolCommands.status(options)
        case .query:
            return try SpoolCommands.query(options)
        case .image:
            return try await SpoolCommands.image(options)
        case .ocr:
            return try await SpoolCommands.ocr(options)
        case .decodeMetadata:
            return try SpoolCommands.decodeMetadata(options)
        case .permissions:
            return try await DiagnosticCommands.permissions(options)
        case .selfTest:
            return try await DiagnosticCommands.selfTest()
        case .inputFocus:
            return try DiagnosticCommands.inputFocus(options)
        case .audioWatch:
            return try await DiagnosticCommands.audioWatch(options)
        case .audioTest:
            return try await DiagnosticCommands.audioTest(options)
        case .resourceWatch:
            return ResourceWatchCommand.watch(options)
        case .capture:
            return try await RecordingCommands.capture(options)
        case .record:
            return try await RecordingCommands.record(options)
        case .app:
            return try RecordingCommands.app(options)
        case .ocrHelper:
            RecognitionHelperServer.serve()
            return .succeeded
        case .launch:
            return try AgentCommands.launch(options)
        case .agents:
            return try await AgentCommands.agents(options)
        case .setup:
            return try await AgentCommands.setup()
        }
    }

    private static func message(for error: Error) -> String {
        if let usage = error as? UsageError { return usage.localizedDescription }
        if let recorder = error as? RecorderError { return recorder.localizedDescription }
        if let control = error as? RecorderControlError { return control.description }
        if let modes = error as? RecordingModesError { return modes.localizedDescription }
        return "Operation failed. Check permissions, capture folder integrity, and available disk space."
    }
}
