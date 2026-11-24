import SwiftUI

public struct MessageQuote: Sendable {
    let speaker: String
    let words: String

    public init(speaker: String, words: String) {
        self.speaker = speaker
        self.words = words
    }
}

public struct MessageBubble<Media: View>: View {
    let words: String
    let mine: Bool
    let speaker: String?
    let quote: MessageQuote?
    let forwarded: Bool
    let edited: Bool
    let gone: Bool
    let reactions: [String]
    let marked: Bool
    let carries: Bool
    let lines: Int?
    let media: Media
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.redactionReasons) private var redaction
    @Environment(\.skeletonTone) private var tone

    public init(_ words: String, mine: Bool, speaker: String? = nil, quote: MessageQuote? = nil, forwarded: Bool = false,
                edited: Bool = false, gone: Bool = false, reactions: [String] = [], marked: Bool = false, lines: Int? = nil,
                @ViewBuilder media: () -> Media) {
        self.words = words
        self.mine = mine
        self.speaker = speaker
        self.quote = quote
        self.forwarded = forwarded
        self.edited = edited
        self.gone = gone
        self.reactions = reactions
        self.marked = marked
        self.lines = lines
        self.media = media()
        self.carries = !(Media.self == EmptyView.self)
    }

    public var body: some View {
        let edge: HorizontalAlignment = mine ? .trailing : .leading
        VStack(alignment: edge, spacing: 2) {
            if let speaker, !mine {
                Text(speaker)
                    .cockpit(.footnote)
                    .fontWeight(.medium)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .padding(.leading, 11)
                    .padding(.top, Cockpit.Space.s2)
            }
            if let quote, carries {
                QuoteLine(quote: quote)
                    .padding(EdgeInsets(top: 5, leading: 11, bottom: 6, trailing: 11))
                    .overlay { Bubble.shape.strokeBorder(Cockpit.Color.border, lineWidth: Cockpit.Stroke.border) }
            }
            if carries {
                media.overlay { if marked && words.isEmpty { Bubble.ring } }
            }
            if !words.isEmpty || gone || (!carries && quote != nil) {
                VStack(alignment: .leading, spacing: 5) {
                    if forwarded { note("Forwarded") }
                    if let quote, !carries { QuoteLine(quote: quote, inAccent: inAccent) }
                    if gone {
                        Text(words.isEmpty ? "This message was deleted." : words)
                            .cockpit(.body)
                            .foregroundStyle(Cockpit.Color.textTertiary)
                    } else if !words.isEmpty {
                        Text(words)
                            .cockpit(.body)
                            .foregroundStyle(inAccent ? Cockpit.Color.accentInk : Cockpit.Color.text)
                            .lineLimit(lines)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                            .opacity(redaction.skeleton ? 0 : 1)
                    }
                    if edited { note("Edited") }
                }
                .padding(EdgeInsets(top: 6, leading: 11, bottom: 7, trailing: 11))
                .background {
                    if !gone {
                        Bubble.shape.fill(redaction.skeleton ? tone : inAccent ? Cockpit.Color.accentSolid : mine ? Cockpit.Color.bubbleOwn
                            : Cockpit.Color.raised)
                    }
                }
                .overlay { if gone { Bubble.shape.strokeBorder(Cockpit.Color.border, lineWidth: Cockpit.Stroke.border) } }
                .overlay { if marked { Bubble.ring } }
                .accessibilityElement(children: .combine)
            }
            if !reactions.isEmpty {
                Text(reactions.joined(separator: "  "))
                    .cockpit(.footnote)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .padding(.horizontal, Cockpit.Space.s2)
            }
        }
        .frame(maxWidth: platform == .mac ? 360 : .infinity, alignment: mine ? .trailing : .leading)
        .padding(mine ? .leading : .trailing, Cockpit.Space.s10)
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(marked ? .isSelected : [])
    }

    private var inAccent: Bool { platform == .ios && mine && !gone }

    private func note(_ words: String) -> some View {
        Text(words).cockpit(.footnote).foregroundStyle(inAccent ? Cockpit.Color.accentInk.opacity(0.75) : Cockpit.Color.textTertiary)
    }
}

extension MessageBubble where Media == EmptyView {
    public init(_ words: String, mine: Bool, speaker: String? = nil, quote: MessageQuote? = nil, forwarded: Bool = false,
                edited: Bool = false, gone: Bool = false, reactions: [String] = [], marked: Bool = false, lines: Int? = nil) {
        self.init(words, mine: mine, speaker: speaker, quote: quote, forwarded: forwarded, edited: edited, gone: gone,
                  reactions: reactions, marked: marked, lines: lines) { EmptyView() }
    }
}

public enum Bubble {
    #if os(iOS)
    public static let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
    #else
    public static let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
    #endif

    @ViewBuilder public static var ring: some View {
        #if os(iOS)
        FoundWash(shape: shape)
        #else
        shape.strokeBorder(Cockpit.Color.here, lineWidth: 1.5).allowsHitTesting(false)
        #endif
    }
}

public struct FoundWash<S: Shape>: View {
    let shape: S
    @State private var shown = true
    @Environment(\.accessibilityReduceMotion) private var still

    public static var found: Duration { .milliseconds(1_500) }

    public init(shape: S) {
        self.shape = shape
    }

    public var body: some View {
        shape.fill(Cockpit.Color.pressed)
            .opacity(shown ? 1 : 0)
            .allowsHitTesting(false)
            .task {
                try? await Task.sleep(for: Self.found)
                withAnimation(still ? nil : .easeOut(duration: Cockpit.Duration.base)) { shown = false }
            }
    }
}

private struct QuoteLine: View {
    let quote: MessageQuote
    var inAccent = false

    var body: some View {
        HStack(spacing: Cockpit.Space.s2) {
            Rectangle().fill(inAccent ? Cockpit.Color.accentInk.opacity(0.6) : Cockpit.Color.data3).frame(width: 2)
            VStack(alignment: .leading, spacing: 0) {
                if !quote.speaker.isEmpty {
                    Text(quote.speaker).cockpit(.footnote).fontWeight(.medium)
                }
                Text(quote.words).cockpit(.footnote).lineLimit(2)
            }
            .foregroundStyle(inAccent ? Cockpit.Color.accentInk.opacity(0.8) : Cockpit.Color.textSecondary)
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Replying to \(quote.speaker): \(quote.words)")
    }
}

public struct ThreadNote: View {
    let words: String
    let clock: Bool

    public init(_ words: String) {
        self.words = words
        clock = false
    }

    public init(clock: String) {
        words = clock
        self.clock = true
    }

    public var body: some View {
        Text(words)
            .cockpit(clock ? .monoTime : .footnote)
            .foregroundStyle(Cockpit.Color.textTertiary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.top, clock ? Cockpit.Space.s4 : Cockpit.Space.s2)
            .padding(.bottom, Cockpit.Space.s2)
    }
}

public struct MessageCard: View {
    let icon: Cockpit.Icon
    let title: String
    let line: String?
    let mine: Bool
    let opens: Bool

    public init(_ title: String, icon: Cockpit.Icon, line: String? = nil, mine: Bool = false, opens: Bool = false) {
        self.icon = icon
        self.title = title
        self.line = line
        self.mine = mine
        self.opens = opens
    }

    public var body: some View {
        HStack(spacing: 10) {
            Icon(icon, size: .md).foregroundStyle(Cockpit.Color.textSecondary)
            VStack(alignment: .leading, spacing: 0) {
                Text(title).cockpit(.body).foregroundStyle(Cockpit.Color.text).lineLimit(2)
                if let line {
                    Text(line).cockpit(.footnote).foregroundStyle(Cockpit.Color.textSecondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if opens { Icon(.openOut, size: .xs).foregroundStyle(Cockpit.Color.accent) }
        }
        .padding(EdgeInsets(top: 7, leading: 11, bottom: 8, trailing: 11))
        .frame(minWidth: 200, alignment: .leading)
        .fixedSize(horizontal: true, vertical: false)
        .background(Bubble.shape.fill(mine ? Cockpit.Color.bubbleOwn : Cockpit.Color.raised))
        .contentShape(Bubble.shape)
        .accessibilityElement(children: .combine)
    }
}

public struct VoiceBar: View {
    let seconds: Double?
    let played: Double
    let playing: Bool
    let loading: Bool
    let mine: Bool
    let toggle: (() -> Void)?

    public init(seconds: Double?, played: Double = 0, playing: Bool = false, loading: Bool = false, mine: Bool = false, toggle: (() -> Void)?) {
        self.seconds = seconds
        self.played = played
        self.playing = playing
        self.loading = loading
        self.mine = mine
        self.toggle = toggle
    }

    public var body: some View {
        HStack(spacing: 10) {
            Button { toggle?() } label: {
                Group {
                    if loading { Spinner() } else { Icon(playing ? .pause : .play, weight: .fill, size: .xs) }
                }
                    .foregroundStyle(toggle == nil ? Cockpit.Color.textTertiary : Cockpit.Color.textInverse)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(toggle == nil ? Cockpit.Color.raised : Cockpit.Color.text))
            }
            .buttonStyle(.plain)
            .disabled(toggle == nil)
            .accessibilityLabel(toggle == nil ? "The recording is not in Lifestream" : loading ? "Stop loading" : playing ? "Pause" : "Play")
            GeometryReader { box in
                ZStack(alignment: .leading) {
                    Capsule().fill(Cockpit.Color.data4)
                    Capsule().fill(Cockpit.Color.text).frame(width: box.size.width * min(1, max(0, played)))
                }
            }
            .frame(height: 3)
            .accessibilityHidden(true)
            Text(Self.clock(playing || played > 0 ? (seconds ?? 0) * played : seconds))
                .cockpit(.monoData)
                .monospacedDigit()
                .foregroundStyle(Cockpit.Color.textSecondary)
        }
        .padding(EdgeInsets(top: 5, leading: 5, bottom: 5, trailing: 12))
        .frame(width: 220)
        .background(Bubble.shape.fill(mine ? Cockpit.Color.bubbleOwn : Cockpit.Color.raised))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Voice note" + (seconds.map { ", " + Self.clock($0) } ?? ""))
    }

    static func clock(_ seconds: Double?) -> String {
        guard let seconds else { return "–:––" }
        let whole = Int(seconds.rounded(.down))
        return "\(whole / 60):" + String(format: "%02d", whole % 60)
    }
}
