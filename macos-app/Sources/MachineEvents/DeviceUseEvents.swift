import Evidence
import Foundation

enum DeviceUseEvents {
    static func visible(_ use: DeviceUse, under modes: RecordingModes) -> DeviceUse {
        guard let audio = use.audio else { return use }
        let shown = { (client: AudioClient) in
            modes.mode(of: client.app) != .exclude && modes.mode(of: client.rawApp) != .exclude
        }
        return DeviceUse(at: use.at,
                         audio: AudioUse(microphone: audio.microphone.filter(shown),
                                         sound: audio.sound.filter(shown), output: audio.output,
                                         input: audio.input, defaultInputRunning: audio.defaultInputRunning),
                         cameras: use.cameras)
    }

    static func merged(_ next: DeviceUse, over held: DeviceUse?) -> DeviceUse {
        DeviceUse(at: next.at, audio: next.audio ?? held?.audio, cameras: next.cameras ?? held?.cameras)
    }

    static func events(from held: DeviceUse?, to next: DeviceUse) -> [MachineEvent] {
        guard let held else { return [] }
        var events: [MachineEvent] = []
        let at = next.at
        let audio = held.audio.flatMap { before in next.audio.map { (before, $0) } }
        if let (before, after) = audio {
            events += clients(before.microphone, after.microphone, at: at, start: .micStart, stop: .micStop)
            events += clients(before.sound, after.sound, at: at, start: .soundStart, stop: .soundStop)
        }
        if let before = held.cameras, let after = next.cameras {
            for camera in before where !after.contains(camera) {
                events.append(MachineEvent(at: at, name: .cameraStop, detail: cameraDetail(camera)))
            }
            for camera in after where !before.contains(camera) {
                events.append(MachineEvent(at: at, name: .cameraStart, detail: cameraDetail(camera)))
            }
        }
        if let (before, after) = audio { events += output(before.output, after.output, at: at) }
        return events
    }

    static func stateDetail(_ use: DeviceUse?) -> [String: MachineEventValue] {
        var detail: [String: MachineEventValue] = [:]
        if let audio = use?.audio {
            detail["mic_in_use"] = .flag(!audio.microphone.isEmpty)
            if !audio.microphone.isEmpty { detail["mic_apps"] = .text(apps(audio.microphone)) }
            detail["sound_in_use"] = .flag(!audio.sound.isEmpty)
            if !audio.sound.isEmpty { detail["sound_apps"] = .text(apps(audio.sound)) }
            for (key, value) in outputDetail(audio.output) { detail["output_" + key] = value }
        } else {
            detail["audio_unavailable"] = .flag(true)
        }
        if let cameras = use?.cameras {
            detail["camera_in_use"] = .flag(!cameras.isEmpty)
        } else {
            detail["camera_unavailable"] = .flag(true)
        }
        return detail
    }


    private static func clients(_ before: [AudioClient], _ after: [AudioClient], at: Date,
                                start: MachineEventName, stop: MachineEventName) -> [MachineEvent] {
        let old = Set(before), new = Set(after)
        let stopped = before.filter { !new.contains($0) }
        let started = after.filter { !old.contains($0) }
        return stopped.map { MachineEvent(at: at, name: stop, detail: clientDetail($0)) }
            + started.map { MachineEvent(at: at, name: start, detail: clientDetail($0)) }
    }

    private static func output(_ before: DeviceLevel, _ after: DeviceLevel, at: Date) -> [MachineEvent] {
        if before.device?.uid != after.device?.uid {
            return [MachineEvent(at: at, name: .outputDevice, detail: outputDetail(after))]
        }
        guard before.volume != after.volume || before.muted != after.muted else { return [] }
        var detail = level(after)
        if let device = after.device { detail["device"] = .text(device.uid) }
        return [MachineEvent(at: at, name: .outputVolume, detail: detail)]
    }

    static func clientDetail(_ client: AudioClient) -> [String: MachineEventValue] {
        var detail: [String: MachineEventValue] = ["app": .text(client.app), "pid": .number(Double(client.pid))]
        if client.rawApp != client.app { detail["raw_app"] = .text(client.rawApp) }
        detail.merge(deviceDetail(client.device)) { held, _ in held }
        return detail
    }

    private static func cameraDetail(_ camera: CameraFacts) -> [String: MachineEventValue] {
        var detail: [String: MachineEventValue] = ["device": .text(camera.uid), "app_unavailable": .flag(true)]
        if let name = camera.name { detail["device_name"] = .text(name) }
        return detail
    }

    private static func deviceDetail(_ device: AudioDeviceFacts?) -> [String: MachineEventValue] {
        guard let device else { return ["device_unavailable": .flag(true)] }
        var detail: [String: MachineEventValue] = ["device": .text(device.uid), "transport": .text(device.transport)]
        if let name = device.name { detail["device_name"] = .text(name) }
        return detail
    }

    private static func outputDetail(_ output: DeviceLevel) -> [String: MachineEventValue] {
        deviceDetail(output.device).merging(level(output)) { held, _ in held }
    }

    private static func level(_ output: DeviceLevel) -> [String: MachineEventValue] {
        var detail: [String: MachineEventValue] = [:]
        if let volume = output.volume { detail["volume"] = .number(volume) } else { detail["volume_unavailable"] = .flag(true) }
        if let muted = output.muted { detail["muted"] = .flag(muted) } else { detail["mute_unavailable"] = .flag(true) }
        return detail
    }

    private static func apps(_ clients: [AudioClient]) -> String {
        Array(Set(clients.map(\.app))).sorted().joined(separator: ",")
    }
}
