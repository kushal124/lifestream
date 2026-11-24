import AppKit
import Evidence
import Foundation
import MachineEvents

@MainActor final class MachineEventsAdapter: RecorderMachine {
    private let events: MachineEventSources
    var availabilityChanged: ((RecorderAvailability) -> Void)?

    var availability: RecorderAvailability {
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        return RecorderAvailability(displayAwake: CGDisplayIsAsleep(CGMainDisplayID()) == 0,
                                    sessionActive: session?[kCGSessionOnConsoleKey as String] as? Bool)
    }

    init(events: MachineEventSources) {
        self.events = events
        events.availabilityChanged = { [weak self] displayAwake, sessionActive in
            MainActor.assumeIsolated {
                guard let self else { return }
                let current = self.availability
                self.availabilityChanged?(RecorderAvailability(displayAwake: displayAwake ?? current.displayAwake,
                                                          sessionActive: sessionActive ?? current.sessionActive))
            }
        }
    }

    func start() {
        events.start()
    }

    func stop() {
        events.stop()
    }

    func setModes(_ modes: RecordingModes) {
        events.setModes(modes)
    }
}
