import AVFoundation
import Combine
import Foundation
import OSLog
import UIKit

@MainActor
final class NotePlayer: ObservableObject {
    enum Sound: Equatable, Hashable {
        case own(String)
        case held(String)
    }

    enum Unplayed: Error, Equatable {
        case missing
        case reach(begun: Int)
        case unplayable
    }

    enum State: Equatable {
        case idle
        case loading
        case playing(at: Double, of: Double)
        case paused(at: Double, of: Double)
        case failed(Unplayed)
    }

    struct Heard: Equatable {
        enum Outcome: Equatable {
            case began
            case sounded
            case failed(Unplayed)
        }

        let sound: Sound
        let play: Int
        let outcome: Outcome
    }

    typealias Read = @MainActor (Sound) async throws(Unplayed) -> Data

    nonisolated static let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("note-player")
    private static let log = Logger(subsystem: "org.lifestreamprotocol.phone", category: "voice")

    @Published private(set) var sound: Sound?
    @Published private(set) var phase: State = .idle
    let heard = PassthroughSubject<Heard, Never>()

    private let player = AVPlayer()
    private weak var owner: AnyObject?
    private var attempt = 0
    private var plays = 0
    private var play = 0
    private var tapped: ContinuousClock.Instant?
    private var got: (at: ContinuousClock.Instant, bytes: Int)?
    private var holds = false
    private var settled: CheckedContinuation<Void, Never>?
    private var watching: NSKeyValueObservation?
    private var watchingItem: [NSKeyValueObservation] = []
    private var ending: [NSObjectProtocol] = []
    private var leaving: NSObjectProtocol?
    private var stopping: [NSObjectProtocol] = []
    private let folder: URL
    private let reading: Read
    private let recording: @MainActor () -> Bool
    private let activate: @MainActor () throws -> Void
    private let giveBack: () -> Void

    init(folder: URL = NotePlayer.cache, read: @escaping Read, recording: @escaping @MainActor () -> Bool,
         activate: @escaping @MainActor () throws -> Void = NotePlayer.activateSession,
         giveBack: @escaping () -> Void = { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) },
         muted: Bool = false) {
        self.folder = folder
        reading = read
        self.recording = recording
        self.activate = activate
        self.giveBack = giveBack
        player.isMuted = muted
        player.actionAtItemEnd = .none
        player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 10), queue: .main) { @Sendable [weak self] _ in
            MainActor.assumeIsolated { self?.sync() }
        }
        watching = player.observe(\.timeControlStatus) { @Sendable [weak self] _, _ in Task { @MainActor in self?.sync() } }
        leaving = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil,
                                                         queue: .main) { @Sendable [weak self] _ in
            MainActor.assumeIsolated { self?.stop() }
        }
        stopping = [
            NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil,
                                                   queue: .main) { @Sendable [weak self] note in
                let began = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt == AVAudioSession.InterruptionType.began.rawValue
                MainActor.assumeIsolated { if began { self?.hold() } }
            },
            NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil,
                                                   queue: .main) { @Sendable [weak self] note in
                let lost = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
                    == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue
                MainActor.assumeIsolated { if lost { self?.hold() } }
            },
        ]
    }

    nonisolated static func clear(_ folder: URL = cache) {
        try? FileManager.default.removeItem(at: folder)
    }

    static func unplayed(_ error: any Error) -> Unplayed {
        switch error as? LifeReader.Failure {
        case .missing?: .missing
        case .reach(let begun)?: .reach(begun: begun)
        default: .unplayable
        }
    }

    static func activateSession() throws {
        let session = AVAudioSession.sharedInstance()
        if session.category != .playAndRecord { try session.setCategory(.playback) }
        try session.setActive(true)
    }

    func state(of sound: Sound) -> State {
        sound == self.sound ? phase : .idle
    }

    @discardableResult
    func toggle(_ sound: Sound, of owner: AnyObject) -> Task<Void, Never>? {
        if sound == self.sound {
            switch phase {
            case .loading:
                end()
                return nil
            case .playing:
                hold()
                return nil
            case let .paused(at, of):
                guard !recording() else { return nil }
                self.owner = owner
                player.play()
                phase = .playing(at: at, of: of)
                return nil
            case .idle, .failed:
                break
            }
        }
        guard !recording() else { return nil }
        end()
        let mine = attempt
        plays += 1
        play = plays
        tapped = .now
        self.sound = sound
        self.owner = owner
        phase = .loading
        heard.send(Heard(sound: sound, play: play, outcome: .began))
        return Task { await load(sound, mine) }
    }

    func seek(to seconds: Double) {
        let at = max(0, seconds)
        switch phase {
        case let .playing(_, of): phase = .playing(at: at, of: of)
        case let .paused(_, of): phase = .paused(at: at, of: of)
        case .idle, .loading, .failed: return
        }
        player.seek(to: CMTime(seconds: at, preferredTimescale: 600))
    }

    func stop(_ owner: AnyObject) {
        guard self.owner === owner else { return }
        end()
    }

    func stop() {
        end()
    }

    nonisolated static func container(of data: Data) -> String? {
        let bytes = [UInt8](data.prefix(12))
        func ascii(_ at: Int, _ length: Int) -> String {
            at + length > bytes.count ? "" : String(decoding: bytes[at..<at + length], as: UTF8.self)
        }
        if ascii(0, 4) == "OggS" { return "ogg" }
        if ascii(0, 4) == "caff" { return "caf" }
        if ascii(4, 4) == "ftyp" { return "m4a" }
        if ascii(0, 4) == "RIFF", ascii(8, 4) == "WAVE" { return "wav" }
        if ascii(0, 3) == "ID3" { return "mp3" }
        if bytes.count >= 2, bytes[0] == 0xFF, bytes[1] & 0xE0 == 0xE0 { return bytes[1] & 0x06 == 0 ? "aac" : "mp3" }
        return nil
    }

    private func load(_ sound: Sound, _ mine: Int) async {
        let data: Data
        do {
            data = try await reading(sound)
        } catch {
            guard mine == attempt else { return }
            guard !recording() else { return end() }
            return fail(error)
        }
        guard mine == attempt else { return }
        guard !recording() else { return end() }
        got = (.now, data.count)
        guard let container = Self.container(of: data) else { return fail(.unplayable) }
        let file = folder.appendingPathComponent("note.\(container)")
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try data.write(to: file, options: .atomic)
            try activate()
        } catch {
            return fail(.unplayable)
        }
        holds = true
        let item = AVPlayerItem(url: file)
        watch(item)
        player.replaceCurrentItem(with: item)
        player.play()
        await withCheckedContinuation { settled = $0 }
    }

    private func watch(_ item: AVPlayerItem) {
        let changed: @Sendable () -> Void = { [weak self] in Task { @MainActor in self?.sync() } }
        watchingItem = [item.observe(\.status) { _, _ in changed() }]
        ending = [
            NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item,
                                                   queue: .main) { @Sendable [weak self] _ in
                MainActor.assumeIsolated { self?.end() }
            },
            NotificationCenter.default.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item,
                                                   queue: .main) { @Sendable [weak self] _ in
                MainActor.assumeIsolated { self?.fail(.unplayable) }
            },
        ]
    }

    private func sync() {
        guard let item = player.currentItem else { return }
        if item.status == .failed { return fail(.unplayable) }
        let at = Self.seconds(player.currentTime())
        let of = Self.seconds(item.duration)
        switch phase {
        case .loading:
            guard player.timeControlStatus == .playing, let sound else { return }
            phase = .playing(at: at, of: of)
            sounded(sound)
            settle()
        case .playing:
            phase = .playing(at: at, of: of)
        case .paused:
            phase = .paused(at: at, of: of)
        case .idle, .failed:
            break
        }
    }

    private func hold() {
        guard case let .playing(at, of) = phase else { return }
        player.pause()
        phase = .paused(at: at, of: of)
    }

    private func end() {
        release()
        sound = nil
        phase = .idle
    }

    private func sounded(_ sound: Sound) {
        if let tapped, let got {
            Self.log.info("voice played: tap to bytes \(Self.ms(got.at - tapped)) ms, bytes to playing \(Self.ms(.now - got.at)) ms, \(got.bytes) bytes")
        }
        heard.send(Heard(sound: sound, play: play, outcome: .sounded))
    }

    private func fail(_ why: Unplayed) {
        guard let sound else { return }
        let kept = owner
        release()
        owner = kept
        phase = .failed(why)
        heard.send(Heard(sound: sound, play: play, outcome: .failed(why)))
    }

    private func release() {
        attempt += 1
        watchingItem = []
        for observer in ending { NotificationCenter.default.removeObserver(observer) }
        ending = []
        player.pause()
        player.replaceCurrentItem(with: nil)
        Self.clear(folder)
        owner = nil
        tapped = nil
        got = nil
        settle()
        guard holds else { return }
        holds = false
        if !recording() { giveBack() }
    }

    private func settle() {
        let settled = settled
        self.settled = nil
        settled?.resume()
    }

    private static func ms(_ duration: Duration) -> Int64 {
        duration.components.seconds * 1000 + duration.components.attoseconds / 1_000_000_000_000_000
    }

    private static func seconds(_ time: CMTime) -> Double {
        time.seconds.isFinite ? max(0, time.seconds) : 0
    }
}
