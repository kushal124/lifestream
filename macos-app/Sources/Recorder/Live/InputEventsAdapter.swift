import Evidence
import Foundation
import InputEvents

@MainActor final class InputEventsAdapter: RecorderInput {
    private let log: InputEventLog

    init(log: InputEventLog) {
        self.log = log
    }

    var status: RecorderInputStatus {
        let status = log.status
        let state: InputLogState
        switch status.state {
        case .recording: state = .recording
        case .permissionRequired: state = .permissionRequired
        case .stopped: state = .stopped
        }
        return RecorderInputStatus(state: state, events: status.events, tapRestarts: status.tapRestarts)
    }

    func start() {
        log.start()
    }

    func stop() {
        log.stop()
    }

    func setModes(_ modes: RecordingModes) {
        log.setModes(modes)
    }
}

@MainActor final class NoInputLog: RecorderInput {
    var status: RecorderInputStatus { RecorderInputStatus(state: .off) }
    func start() {}
    func stop() {}
    func setModes(_ modes: RecordingModes) {}
}
