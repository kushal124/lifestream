import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

public struct AskQuestion: View {
    public struct Voice {
        let time: String
        let levels: [Double]
        let played: Int?
        let playing: Bool
        let play: () -> Void
        let words: String?
        let writing: Bool

        public init(time: String, levels: [Double], played: Int? = nil, playing: Bool = false, words: String?,
                    writing: Bool = true, play: @escaping () -> Void) {
            self.time = time
            self.levels = levels
            self.played = played
            self.playing = playing
            self.words = words
            self.writing = writing
            self.play = play
        }
    }

    let words: String
    let at: String?
    let stamp: String?
    let picture: AnyView?
    let voice: Voice?
    let edit: (() -> Void)?
    let seen: [AskSeen.Span]?
    let modelView: Bool
    var forcedHover = false
    @State private var hovering = false
    @State private var clock: SeenClock?
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.redactionReasons) private var redaction
    @Environment(\.skeletonTone) private var tone

    public init(_ words: String, at: String? = nil, stamp: String? = nil, picture: AnyView? = nil, edit: (() -> Void)? = nil,
                seen: [AskSeen.Span]? = nil, modelView: Bool = false) {
        self.words = words
        self.at = at
        self.stamp = stamp
        self.picture = picture
        self.voice = nil
        self.edit = edit
        self.seen = seen
        self.modelView = modelView
    }

    public init(voice: Voice, at: String? = nil, stamp: String? = nil, picture: AnyView? = nil,
                seen: [AskSeen.Span]? = nil, modelView: Bool = false) {
        self.words = voice.words ?? ""
        self.at = at
        self.stamp = stamp
        self.picture = picture
        self.voice = voice
        self.edit = nil
        self.seen = seen
        self.modelView = modelView
    }

    private func said(_ words: String, _ role: Cockpit.Role) -> some View {
        SeenWords(words: words, spans: seen, on: modelView, clock: clock, size: platform.style(role).size)
            .modifier(SeenFlip(on: modelView, clock: $clock))
    }

    private var phone: Bool { platform == .ios }

    public var body: some View {
        VStack(spacing: Cockpit.Space.s3) {
            if let stamp {
                Text(stamp)
                    .cockpit(.footnote)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .frame(maxWidth: .infinity)
            }
            VStack(alignment: .trailing, spacing: Cockpit.Space.s1 + 2) {
                if let picture {
                    let width = phone ? Cockpit.Size.questionPicture : 240
                    picture
                        .frame(width: width, height: width * 3 / 4)
                        .clipShape(RoundedRectangle(cornerRadius: phone ? Cockpit.Radius.picture : Cockpit.Radius.lg, style: .continuous))
                        .accessibilityLabel("Picture")
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                Group {
                    if let voice { note(voice) } else if !words.isEmpty || picture == nil { bubble }
                }
                .modifier(TrailingShare(width: voice == nil ? nil : phone ? Cockpit.Size.voiceNote : 320))
                if platform == .mac, let edit {
                    Button("Edit", action: edit)
                        .buttonStyle(.cockpit(.plain, size: .small))
                        .opacity(hovering || forcedHover ? 1 : 0)
                }
            }
        }
        .onHover { hovering = $0 }
        .help(at ?? "")
        .accessibilityElement(children: .combine)
        .accessibilityActions { if let edit { Button("Edit", action: edit) } }
    }

    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: Cockpit.Radius.bubble, style: .continuous) }

    private var bubble: some View {
        said(words, .reading)
            .cockpit(.reading)
            .foregroundStyle(Cockpit.Color.text)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .opacity(redaction.skeleton ? 0 : 1)
            .padding(.vertical, phone ? Cockpit.Space.s3 - 2 : 9)
            .padding(.horizontal, phone ? Cockpit.Space.s4 : Cockpit.Space.s3 + 2)
            .background(shape.fill(redaction.skeleton ? tone : Cockpit.Color.bubbleOwn))
            .contextMenu { if platform == .ios { menu } }
    }

    private func note(_ voice: Voice) -> some View {
        let play = phone ? 32.0 : 28.0
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Cockpit.Space.s3 - 2) {
                Button(action: voice.play) {
                    Circle().fill(Cockpit.Color.accentSolid)
                        .overlay { Icon(voice.playing ? .pause : .play, weight: .fill, size: .sm).foregroundStyle(Cockpit.Color.accentInk) }
                        .frame(width: play, height: play)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(voice.playing ? "Pause the voice note" : "Play the voice note")
                Wave(levels: voice.levels, height: 22, quiet: voice.played ?? 0)
                Text(voice.time)
                    .cockpit(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .fixedSize()
            }
            if let words = voice.words {
                said(words, .subhead)
                    .cockpit(.subhead)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .padding(.top, Cockpit.Space.s2)
            } else if voice.writing {
                Text("Writing it out…")
                    .cockpit(.footnote)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .padding(.top, Cockpit.Space.s1 + 2)
            }
        }
        .padding(.vertical, Cockpit.Space.s3 - 2)
        .padding(.horizontal, Cockpit.Space.s3 + 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(shape.fill(Cockpit.Color.bubbleOwn))
        .contextMenu { if platform == .ios, voice.words != nil { menu } }
    }

    @ViewBuilder private var menu: some View {
        if let at { Text(at) }
        Button("Copy") { Pasteboard.copy(words) }
        if let edit { Button("Edit", action: edit) }
    }
}

enum Pasteboard {
    @MainActor static func copy(_ words: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = words
        #elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(words, forType: .string)
        #endif
    }
}

private struct TrailingShare: ViewModifier {
    let width: CGFloat?

    func body(content: Content) -> some View {
        ShareLayout(width: width) { content }
    }

    private struct ShareLayout: Layout {
        let width: CGFloat?
        static let share: CGFloat = 0.78

        private func proposed(_ column: CGFloat?) -> ProposedViewSize {
            let most = column.map { $0 * Self.share }
            return ProposedViewSize(width: width.map { min($0, most ?? $0) } ?? most, height: nil)
        }

        func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
            guard let child = subviews.first else { return .zero }
            let size = child.sizeThatFits(proposed(proposal.width))
            return CGSize(width: proposal.width ?? size.width, height: size.height)
        }

        func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
            guard let child = subviews.first else { return }
            let size = child.sizeThatFits(proposed(bounds.width))
            child.place(at: CGPoint(x: bounds.maxX - size.width, y: bounds.minY), proposal: ProposedViewSize(size))
        }
    }
}
