import AVFoundation
import CoreMedia
import Evidence
import Foundation

public enum MicrophoneSourceError: Error, Equatable, CustomStringConvertible {
    case deviceNotFound
    case input
    case output
    case notAMicrophone

    public var description: String {
        switch self {
        case .deviceNotFound: return "the input device is not available"
        case .input: return "the input device could not be opened"
        case .output: return "the audio output could not be attached"
        case .notAMicrophone: return "this source captures a microphone only"
        }
    }
}

public final class CaptureSessionMicrophoneSource: AudioSource, @unchecked Sendable {
    private var session: AVCaptureSession?
    private var handoff: SampleHandoff?
    private var failure: NSObjectProtocol?

    public init() {}

    public func start(_ capture: AudioCapture, queue: DispatchQueue,
                      deliver: @escaping (AudioChunk) -> Void, failed: @escaping (String) -> Void) throws {
        stop()
        guard case .microphone(let deviceUID) = capture else { throw MicrophoneSourceError.notAMicrophone }
        guard let device = AVCaptureDevice(uniqueID: deviceUID), device.hasMediaType(.audio) else {
            throw MicrophoneSourceError.deviceNotFound
        }
        let input: AVCaptureDeviceInput
        do { input = try AVCaptureDeviceInput(device: device) } catch { throw MicrophoneSourceError.input }
        let session = AVCaptureSession()
        session.beginConfiguration()
        guard session.canAddInput(input) else { throw MicrophoneSourceError.input }
        session.addInput(input)
        let output = AVCaptureAudioDataOutput()
        output.audioSettings = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: AudioFormat.sampleRate,
            AVNumberOfChannelsKey: AudioFormat.channels,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        let handoff = SampleHandoff(recorder: queue, clock: { [weak session] in
            session?.synchronizationClock ?? CMClockGetHostTimeClock()
        }, deliver: deliver)
        output.setSampleBufferDelegate(handoff, queue: handoff.queue)
        guard session.canAddOutput(output) else { throw MicrophoneSourceError.output }
        session.addOutput(output)
        session.commitConfiguration()
        self.handoff = handoff
        failure = NotificationCenter.default.addObserver(forName: AVCaptureSession.runtimeErrorNotification,
                                                         object: session, queue: nil) { _ in
            queue.async { failed("the capture session stopped with a runtime error") }
        }
        self.session = session
        session.startRunning()
    }

    public func stop() {
        if let failure { NotificationCenter.default.removeObserver(failure) }
        failure = nil
        session?.stopRunning()
        session = nil
        handoff = nil
    }
}

final class SampleHandoff: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "org.lifestreamprotocol.audio.microphone")
    private let recorder: DispatchQueue
    private let clock: () -> CMClock
    private let deliver: (AudioChunk) -> Void

    init(recorder: DispatchQueue, clock: @escaping () -> CMClock, deliver: @escaping (AudioChunk) -> Void) {
        self.recorder = recorder
        self.clock = clock
        self.deliver = deliver
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        take(sampleBuffer)
    }

    func take(_ buffer: CMSampleBuffer) {
        ResourceMeter.shared.measure(.audioMic, units: 0) { handOver(buffer) }
    }

    private func handOver(_ buffer: CMSampleBuffer) {
        let time = CMSampleBufferGetPresentationTimeStamp(buffer)
        let age = CMTimeSubtract(CMClockGetTime(clock()), time).seconds
        let at = Date().addingTimeInterval(-(age.isFinite ? max(0, age) : 0))
        let frames = CMSampleBufferGetNumSamples(buffer)
        let rate = CMSampleBufferGetFormatDescription(buffer)
            .flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee.mSampleRate } ?? 0
        let chunk = AudioChunk(buffer: PCMSampleBuffer.copy(buffer) ?? buffer, at: at,
                               duration: Double(frames) / (rate > 0 ? rate : Double(AudioFormat.sampleRate)))
        recorder.async { [deliver] in deliver(chunk) }
    }
}
