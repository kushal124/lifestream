import AppKit
import Foundation
import Recorder

@MainActor enum RecordingCommands {
    static func capture(_ options: Options) async throws -> CommandOutcome {
        let ownership = try RecorderControlServer(directory: options.directory) { _ in
            ControlResponse(ok: false, state: "one_shot_capture", message: "Wait for the one-shot capture to finish")
        }
        defer { ownership.close() }
        let recorder = try Recorder.live(options, process: .current)
        if options.request { Grant.requestMissing() }
        try await recorder.captureOnce()
        try writeJSONLine(recorder.status)
        return recorder.status.recorded == 0 ? .failed : .succeeded
    }

    static func record(_ options: Options) async throws -> CommandOutcome {
        let ownership = try RecorderControlServer(directory: options.directory) { _ in
            ControlResponse(ok: false, state: "foreground_recording",
                            message: "Use the app for remote lifecycle controls")
        }
        defer { ownership.close() }
        let recorder = try Recorder.live(options, process: .current)
        if options.request { Grant.requestMissing() }
        guard Grant.screenRecording.granted else { throw UsageError.message("Screen recording permission is required") }
        try recorder.start()
        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)
        let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        interrupt.setEventHandler { Task { await recorder.stop() } }
        terminate.setEventHandler { Task { await recorder.stop() } }
        interrupt.resume()
        terminate.resume()
        await recorder.waitUntilStopped()
        interrupt.cancel()
        terminate.cancel()
        try writeJSONLine(recorder.status)
        return recorder.status.storageFailure == nil ? .succeeded : .failed
    }

    static func app(_ options: Options) throws -> CommandOutcome {
        let app = NSApplication.shared
        let updates = Updates()
        updates.start()
        let delegate = try MenuBarApp(options: options, updates: updates)
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
        return .succeeded
    }
}
