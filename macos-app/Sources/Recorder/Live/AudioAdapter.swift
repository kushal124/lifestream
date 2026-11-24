import Audio
import Evidence
import Foundation

extension AudioRecorder: RecorderAudio {}

@MainActor final class NoAudio: RecorderAudio {
    var status: AudioStatus { AudioStatus(mic: .stopped, sound: .stopped) }
    func start() {}
    func stop() {}
    func setModes(_ modes: RecordingModes) {}
}
