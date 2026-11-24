import CoreMedia
import Foundation

public enum AudioTrack: String, Codable, CaseIterable, Sendable {
    case mic
    case sound
}

public enum AudioCapture: Equatable, Sendable {
    case microphone(uid: String)
    case sound
}

public struct AudioChunk: @unchecked Sendable {
    public let buffer: CMSampleBuffer
    public let at: Date
    public let duration: TimeInterval

    public init(buffer: CMSampleBuffer, at: Date, duration: TimeInterval) {
        self.buffer = buffer
        self.at = at
        self.duration = duration
    }
}

public enum AudioFormat {
    public static let sampleRate = 16_000
    public static let channels = 1
    public static let bitRate = 32_000
    public static let codec = "aac"
    public static let mediaType = "audio/mp4"
}

public protocol AudioSource: AnyObject {
    func start(_ capture: AudioCapture, queue: DispatchQueue,
               deliver: @escaping (AudioChunk) -> Void, failed: @escaping (String) -> Void) throws
    func stop()
}

public struct AudioSources {
    public var mic: any AudioSource
    public var sound: any AudioSource

    public init(mic: any AudioSource, sound: any AudioSource) {
        self.mic = mic
        self.sound = sound
    }

    public static func live() -> AudioSources {
        AudioSources(mic: CaptureSessionMicrophoneSource(), sound: ProcessTapSoundSource())
    }

    subscript(track: AudioTrack) -> any AudioSource {
        switch track {
        case .mic: return mic
        case .sound: return sound
        }
    }
}
