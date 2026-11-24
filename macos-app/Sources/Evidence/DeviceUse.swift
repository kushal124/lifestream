import Foundation

public struct AudioDeviceFacts: Hashable, Sendable {
    public let uid: String
    public let name: String?
    public let transport: String

    public init(uid: String, name: String?, transport: String) {
        self.uid = uid
        self.name = name
        self.transport = transport
    }
}

public struct AudioClient: Hashable, Sendable, Comparable {
    public let pid: Int32
    public let app: String
    public let rawApp: String
    public let device: AudioDeviceFacts?

    public init(pid: Int32, app: String, rawApp: String, device: AudioDeviceFacts?) {
        self.pid = pid
        self.app = app
        self.rawApp = rawApp
        self.device = device
    }

    public static func < (left: AudioClient, right: AudioClient) -> Bool {
        if left.app != right.app { return left.app < right.app }
        let a = left.device?.uid ?? "", b = right.device?.uid ?? ""
        if a != b { return a < b }
        if left.pid != right.pid { return left.pid < right.pid }
        return left.rawApp < right.rawApp
    }
}

public struct CameraFacts: Hashable, Sendable, Comparable {
    public let uid: String
    public let name: String?

    public init(uid: String, name: String?) {
        self.uid = uid
        self.name = name
    }

    public static func < (left: CameraFacts, right: CameraFacts) -> Bool { left.uid < right.uid }
}

public struct DeviceLevel: Equatable, Sendable {
    public let device: AudioDeviceFacts?
    public let volume: Double?
    public let muted: Bool?

    public init(device: AudioDeviceFacts?, volume: Double?, muted: Bool?) {
        self.device = device
        self.volume = volume.map { ($0 * 100).rounded() / 100 }
        self.muted = muted
    }
}

public struct AudioUse: Equatable, Sendable {
    public let microphone: [AudioClient]
    public let sound: [AudioClient]
    public let output: DeviceLevel
    public let input: DeviceLevel
    public let defaultInputRunning: Bool

    public init(microphone: [AudioClient], sound: [AudioClient], output: DeviceLevel, input: DeviceLevel,
                defaultInputRunning: Bool) {
        self.microphone = microphone.sorted()
        self.sound = sound.sorted()
        self.output = output
        self.input = input
        self.defaultInputRunning = defaultInputRunning
    }
}

public struct DeviceUse: Equatable, Sendable {
    public let at: Date
    public let audio: AudioUse?
    public let cameras: [CameraFacts]?

    public init(at: Date, audio: AudioUse?, cameras: [CameraFacts]?) {
        self.at = at
        self.audio = audio
        self.cameras = cameras?.sorted()
    }
}
