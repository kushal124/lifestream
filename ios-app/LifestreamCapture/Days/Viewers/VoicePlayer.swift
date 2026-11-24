import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct VoicePlayer: View {
    let ref: HomeLink.DayFile.RecordRef
    let stated: TimeInterval
    @EnvironmentObject private var reads: InspectorReads
    @ObservedObject private var player = NotePlayer.shared
    @State private var surface = NSObject()
    @State private var hash: String?
    @State private var unread: NotePlayer.Unplayed?

    var body: some View {
        let state = hash.map { player.state(of: .held($0)) } ?? .idle
        let why = unread ?? Self.why(state)
        VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
            HStack(spacing: Cockpit.Space.s3) {
                IconButton(Self.playing(state) ? .pause : .play, label: Self.label(state), style: .raised, size: .medium, weight: .fill) {
                    Task { await toggle() }
                }
                .accessibilityIdentifier("inspector.play")
                Scrubber(position: Self.position(state), length: length(state), seek: Self.held(state) ? { player.seek(to: $0) } : nil)
            }
            HStack {
                if state == .loading { Spinner() } else { Text(Self.clock(Self.position(state))) }
                Spacer(minLength: 0)
                Text(Self.clock(length(state)))
            }
            .padding(.leading, 36 + Cockpit.Space.s3)
            .cockpit(.monoData)
            .monospacedDigit()
            .foregroundStyle(Cockpit.Color.textTertiary)
            .accessibilityHidden(true)
            switch why {
            case .missing?: InPlaceLine(Self.notHeld)
            case .reach?: PageLack(Self.notHere, retry: { Task { await toggle() } })
            case .unplayable?: InPlaceLine(VoiceWords.unplayed, retry: { Task { await toggle() } })
            case nil: EmptyView()
            }
        }
        .onDisappear { player.stop(surface) }
        .readsAgain(begun: { if case .reach(let begun)? = why { begun } else { nil } }) {
            unread = nil
            player.stop(surface)
        }
    }

    private static let notHeld = "The recording is not in Lifestream."
    private static let notHere = "This recording isn't on this iPhone yet."

    private static func why(_ state: NotePlayer.State) -> NotePlayer.Unplayed? {
        if case .failed(let why) = state { why } else { nil }
    }

    private func length(_ state: NotePlayer.State) -> TimeInterval {
        switch state {
        case let .playing(_, of), let .paused(_, of): of > 0 ? of : stated
        case .idle, .loading, .failed: stated
        }
    }

    private static func position(_ state: NotePlayer.State) -> TimeInterval {
        switch state {
        case let .playing(at, _), let .paused(at, _): at
        case .idle, .loading, .failed: 0
        }
    }

    private static func playing(_ state: NotePlayer.State) -> Bool {
        if case .playing = state { true } else { false }
    }

    private static func held(_ state: NotePlayer.State) -> Bool {
        switch state {
        case .playing, .paused: true
        case .idle, .loading, .failed: false
        }
    }

    private static func label(_ state: NotePlayer.State) -> String {
        switch state {
        case .loading: "Stop loading"
        case .playing: "Pause"
        case .paused, .idle, .failed: "Play"
        }
    }

    private func toggle() async {
        if let hash { player.toggle(.held(hash), of: surface); return }
        unread = nil
        do {
            guard let found = try await reads.record(ref).blobs.first else { unread = .missing; return }
            hash = found
            player.toggle(.held(found), of: surface)
        } catch {
            unread = NotePlayer.unplayed(error)
        }
    }

    private static func clock(_ seconds: TimeInterval) -> String {
        let total = Int(seconds.rounded(.down))
        return "\(total / 60):" + String(format: "%02d", total % 60)
    }
}

private struct Scrubber: View {
    let position: TimeInterval
    let length: TimeInterval
    let seek: ((TimeInterval) -> Void)?

    private static let thumb: CGFloat = 14

    var body: some View {
        GeometryReader { proxy in
            let width = max(proxy.size.width - Self.thumb, 1)
            let share = length > 0 ? min(1, max(0, position / length)) : 0
            ZStack(alignment: .leading) {
                Capsule().fill(Cockpit.Color.strokeControl).frame(height: 4)
                ZStack(alignment: .leading) {
                    Capsule().fill(Cockpit.Color.text).frame(width: Self.thumb / 2 + width * share, height: 4)
                    Circle()
                        .fill(Cockpit.Color.text)
                        .frame(width: Self.thumb, height: Self.thumb)
                        .offset(x: width * share)
                }
                .compositingGroup()
                .opacity(seek == nil ? 0.5 : 1)
            }
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { drag in
                guard let seek, length > 0 else { return }
                seek(min(1, max(0, (drag.location.x - Self.thumb / 2) / width)) * length)
            })
        }
        .frame(height: Cockpit.Size.target)
        .accessibilityElement()
        .accessibilityLabel("Position")
        .accessibilityValue(Words.duration(position) + " of " + Words.duration(length))
        .accessibilityAdjustableAction { direction in
            guard let seek else { return }
            seek(min(length, max(0, position + (direction == .increment ? 5 : -5))))
        }
    }
}
