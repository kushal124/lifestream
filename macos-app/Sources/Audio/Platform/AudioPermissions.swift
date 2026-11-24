import AVFoundation
import Foundation

public enum AudioPermissions {
    public static func status(_ track: AudioTrack) -> AudioAuthorization {
        switch track {
        case .mic:
            switch AVCaptureDevice.authorizationStatus(for: .audio) {
            case .authorized: return .granted
            case .notDetermined: return .undetermined
            default: return .denied
            }
        case .sound:
            return SystemAudioAccess.preflight()
        }
    }

    public static func granted(_ track: AudioTrack) -> Bool { status(track) == .granted }

    public static func request(_ track: AudioTrack) async -> Bool {
        switch track {
        case .mic: return await AVCaptureDevice.requestAccess(for: .audio)
        case .sound: return await withCheckedContinuation { done in SystemAudioAccess.request { done.resume(returning: $0) } }
        }
    }
}

enum SystemAudioAccess {
    private static let service = "kTCCServiceAudioCapture" as CFString
    private typealias Preflight = @convention(c) (CFString, CFDictionary?) -> Int
    private typealias Request = @convention(c) (CFString, CFDictionary?, @escaping (Bool) -> Void) -> Void

    private static let framework = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW)

    static func preflight() -> AudioAuthorization {
        guard let symbol = framework.flatMap({ dlsym($0, "TCCAccessPreflight") }) else { return .undetermined }
        switch unsafeBitCast(symbol, to: Preflight.self)(service, nil) {
        case 0: return .granted
        case 1: return .denied
        default: return .undetermined
        }
    }

    static func request(_ answer: @escaping (Bool) -> Void) {
        guard let symbol = framework.flatMap({ dlsym($0, "TCCAccessRequest") }) else { return answer(false) }
        unsafeBitCast(symbol, to: Request.self)(service, nil, answer)
    }
}
