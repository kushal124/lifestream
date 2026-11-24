import SwiftUI

public enum VoiceWords {
    public static let unplayed = "This voice note didn't play."
    public static let erased = "This voice note was erased."
    public static let someone = "Someone"
}

public struct VoiceCite: View {
    public enum Look: Sendable, Equatable {
        case ready
        case loading
        case playing(at: Double, of: Double)
        case paused(at: Double, of: Double)
        case erased
        case unplayed
        case unreached(String)
    }

    let voice: AskRef.Voice
    let look: Look
    let toggle: () -> Void
    let open: () -> Void

    public init(_ voice: AskRef.Voice, look: Look, toggle: @escaping () -> Void, open: @escaping () -> Void) {
        self.voice = voice
        self.look = look
        self.toggle = toggle
        self.open = open
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
            switch look {
            case .erased:
                Text(VoiceWords.erased)
                    .cockpit(.subhead)
                    .foregroundStyle(Cockpit.Color.textSecondary)
            case .unplayed:
                InPlaceLine(VoiceWords.unplayed, retry: toggle)
            case let .unreached(words):
                InPlaceLine(words, retry: toggle)
            case .ready, .loading, .playing, .paused:
                bar
            }
            if !voice.caption.isEmpty {
                Button(action: open) {
                    Text(voice.caption)
                        .cockpit(.subhead)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .lineLimit(1)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the conversation at this note")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    private var bar: VoiceBar {
        let stated = voice.seconds.map(Double.init)
        switch look {
        case .loading:
            return VoiceBar(seconds: stated, loading: true, mine: voice.mine, toggle: toggle)
        case let .playing(at, of), let .paused(at, of):
            let length = of > 0 ? of : stated
            let playing = if case .playing = look { true } else { false }
            return VoiceBar(seconds: length, played: length.flatMap { $0 > 0 ? at / $0 : nil } ?? 0, playing: playing, mine: voice.mine, toggle: toggle)
        case .ready, .erased, .unplayed, .unreached:
            return VoiceBar(seconds: stated, mine: voice.mine, toggle: toggle)
        }
    }
}
