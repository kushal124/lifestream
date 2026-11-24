import AVFoundation
import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI
import UIKit

@MainActor
final class ViewerPlayer: ObservableObject {
    @Published private(set) var play: HomeLink.Photo.Play?
    @Published private(set) var state: VideoBar.State = .paused
    @Published private(set) var elapsed: Double = 0
    @Published private(set) var length: Double?
    @Published private(set) var muted = false
    @Published private(set) var moving = false
    @Published private(set) var moved = 0
    @Published private(set) var unreached = false

    let player = AVPlayer()
    private var loader: VideoLoader?
    private var watching: NSKeyValueObservation?
    private var watchingItem: [NSKeyValueObservation] = []
    private var failing: NSObjectProtocol?
    private let life: LifeReader
    private let reach: HomeReach
    private var scrubbing: Bool?
    private var counted = false
    private var released: Date?

    init(life: LifeReader = AppRuntime.shared.life, reach: HomeReach = AppRuntime.shared.reach) {
        self.life = life
        self.reach = reach
        player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 10), queue: .main) { @Sendable [weak self] _ in
            MainActor.assumeIsolated { self?.sync() }
        }
        watching = player.observe(\.timeControlStatus) { @Sendable [weak self] _, _ in Task { @MainActor in self?.sync() } }
    }

    func show(_ play: HomeLink.Photo.Play?, recording: Bool) {
        guard play != self.play || unreached else { return }
        stop()
        self.play = play
        guard let play else { return }
        session(for: play, recording: recording)
        let loader = life.video(play)
        self.loader = loader
        let item = AVPlayerItem(asset: loader.asset)
        let heard: @Sendable () -> Void = { [weak self] in Task { @MainActor in self?.sync() } }
        watchingItem = [item.observe(\.status) { _, _ in heard() }, item.observe(\.loadedTimeRanges) { _, _ in heard() }]
        failing = NotificationCenter.default.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item,
                                                         queue: .main) { @Sendable [weak self] _ in
            MainActor.assumeIsolated { self?.failed() }
        }
        player.replaceCurrentItem(with: item)
        player.isMuted = play.live ? false : muted
        if !play.live { player.play() }
    }

    func again(recording: Bool) {
        guard unreached else { return }
        show(play, recording: recording)
    }

    func end(recording: Bool) {
        stop()
        play = nil
        session(for: nil, recording: recording)
    }

    var said: Bool {
        if case .said = state { true } else { false }
    }

    var bar: Bool { play.map { !$0.live || said } ?? false }

    var live: Bool { play?.live == true && !said }

    static func session(for play: HomeLink.Photo.Play?, recording: Bool) -> AVAudioSession.Category? {
        guard !recording else { return nil }
        return play.map { $0.live ? .ambient : .playback } ?? .ambient
    }


    func toggle() {
        guard player.currentItem != nil, play?.live == false else { return }
        if player.timeControlStatus != .paused { return player.pause() }
        if let length, elapsed >= length - 0.05 { player.seek(to: .zero) }
        player.play()
    }

    func seek(_ seconds: Double, done: Bool) {
        if scrubbing == nil {
            scrubbing = player.timeControlStatus != .paused
            player.pause()
        }
        elapsed = seconds
        let near = CMTime(seconds: done ? 0 : 0.25, preferredTimescale: 600)
        player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), toleranceBefore: near, toleranceAfter: near)
        guard done else { return }
        if scrubbing == true { player.play() }
        scrubbing = nil
    }

    func mute() {
        muted.toggle()
        player.isMuted = muted
    }


    func press(_ held: Bool) {
        guard live, player.currentItem != nil else { return }
        if held {
            counted = false
            moving = true
            player.seek(to: .zero)
            player.play()
        } else {
            released = .now
            stopMoving()
        }
    }

    func playMotion() {
        press(true)
    }

    var pressing: Bool {
        moving || released.map { Date.now.timeIntervalSince($0) < 0.25 } ?? false
    }


    private func stopMoving() {
        moving = false
        player.pause()
    }

    private func stop() {
        loader?.cancel()
        loader = nil
        player.pause()
        player.replaceCurrentItem(with: nil)
        watchingItem = []
        failing.map { NotificationCenter.default.removeObserver($0) }
        failing = nil
        (state, elapsed, length, moving, unreached, scrubbing) = (.paused, 0, nil, false, false, nil)
    }

    private func sync() {
        guard let play, let item = player.currentItem, !said else { return }
        if item.status == .failed { return failed() }
        let now = player.currentTime()
        let held = item.loadedTimeRanges.map(\.timeRangeValue).first { $0.containsTime(now) }
        loader?.buffered(ahead: held.map { ($0.end - now).seconds } ?? 0)
        let duration = item.duration.seconds
        length = duration.isFinite && duration > 0 ? duration : nil
        if scrubbing == nil { elapsed = max(0, player.currentTime().seconds.isFinite ? player.currentTime().seconds : 0) }
        let status = player.timeControlStatus
        if play.live {
            if moving, status == .playing, !counted {
                counted = true
                moved += 1
            }
            if moving, counted, status == .paused { stopMoving() }
            return
        }
        guard scrubbing == nil else { return }
        state = switch status {
        case .playing: .playing
        case .waitingToPlayAtSpecifiedRate: .waiting
        case .paused: .paused
        @unknown default: .paused
        }
    }

    private func failed() {
        guard player.currentItem != nil else { return }
        moving = false
        player.pause()
        if reach.snapshot.reach != .answering {
            unreached = true
            state = .said("This video can't play right now.")
        } else {
            state = .said("This video can't play here.")
        }
    }

    private func session(for play: HomeLink.Photo.Play?, recording: Bool) {
        guard let category = Self.session(for: play, recording: recording) else { return }
        try? AVAudioSession.sharedInstance().setCategory(category)
    }
}

struct VideoPage: View {
    let hash: String
    let current: Bool
    @ObservedObject var player: ViewerPlayer
    let drawn: (CGSize) -> Void
    let acts: PhotoPage.Acts
    @State private var poster: UIImage?

    var body: some View {
        ZStack {
            if let poster {
                Image(uiImage: poster).resizable().scaledToFit()
            }
            if current {
                PlayerSurface(player: player.player)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture { acts.tap() }
        .accessibilityElement()
        .accessibilityLabel(acts.said)
        .accessibilityAddTraits(.startsMediaSession)
        .accessibilityAction(named: player.state == .playing ? "Pause" : "Play") { player.toggle() }
        .accessibilityAction(named: "Next photo", acts.next)
        .accessibilityAction(named: "Previous photo", acts.previous)
        .accessibilityAction(named: "Info", acts.info)
        .accessibilityAction(named: "Close", acts.close)
        .accessibilityIdentifier(current ? "viewer.photo" : "viewer.page")
        .accessibilityValue(AppRuntime.isUITesting ? "video \(hash.dropFirst("sha256:".count).prefix(12))" : "")
        .task(id: hash) {
            guard let made = try? await HomePictures.shared.read(hash, .screen, side: PictureDecode.largest) else { return }
            poster = made
            drawn(made.size)
        }
    }
}

struct PlayerSurface: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> Surface {
        let surface = Surface()
        surface.isUserInteractionEnabled = false
        surface.shown.videoGravity = .resizeAspect
        surface.shown.player = player
        return surface
    }

    func updateUIView(_ surface: Surface, context: Context) {
        if surface.shown.player !== player { surface.shown.player = player }
    }

    final class Surface: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var shown: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}
