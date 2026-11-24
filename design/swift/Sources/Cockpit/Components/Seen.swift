import SwiftUI

public struct AskSeen: Sendable, Equatable {
    public struct Span: Sendable, Equatable {
        public enum Kind: Sendable { case placeholder, added }

        public let start: Int
        public let end: Int
        public let said: String
        public let kind: Kind

        public static func placeholder(_ start: Int, _ end: Int, _ said: String) -> Span {
            Span(start: start, end: end, said: said, kind: .placeholder)
        }

        public static func added(_ at: Int, _ said: String) -> Span {
            Span(start: at, end: at, said: said, kind: .added)
        }
    }

    public let asked: [Span]
    public let spoken: String?
    public let answered: [Span]
    public let photos: [String?]?

    public init(asked: [Span], spoken: String? = nil, answered: [Span], photos: [String?]? = nil) {
        self.asked = asked
        self.spoken = spoken
        self.answered = answered
        self.photos = photos
    }

    public static func fits(_ text: String, _ spans: [Span]) -> Bool {
        let count = text.utf16.count
        var at = 0
        for span in spans {
            guard span.start >= at, span.end >= span.start, span.end <= count else { return false }
            if span.kind == .added, span.end != span.start { return false }
            at = span.end
        }
        return true
    }

    public enum End: Sendable { case running, done, stopped, failed }

    public static func eye(_ seen: AskSeen?, words: String, voice: Bool, photos: Int, answer: String, end: End) -> AskSeen? {
        guard let seen else { return nil }
        switch end {
        case .done: break
        case .stopped where !answer.isEmpty: break
        case .running, .stopped, .failed: return nil
        }
        guard seen.spoken == (voice ? words : nil), fits(words, seen.asked), fits(answer, seen.answered),
              (seen.photos?.count ?? 0) == photos, (seen.photos == nil) == (photos == 0) else { return nil }
        guard !seen.asked.isEmpty || !seen.answered.isEmpty || seen.photos?.contains(where: { $0 != nil }) == true else { return nil }
        return seen
    }

    static func pieces(_ text: String, _ spans: [Span]) -> [(words: String, span: Int?)] {
        let units = Array(text.utf16)
        var pieces: [(String, Int?)] = []
        var at = 0
        for (index, span) in spans.enumerated() {
            if span.start > at { pieces.append((String(decoding: units[at..<span.start], as: UTF16.self), nil)) }
            pieces.append((String(decoding: units[span.start..<span.end], as: UTF16.self), index))
            at = span.end
        }
        if at < units.count { pieces.append((String(decoding: units[at...], as: UTF16.self), nil)) }
        return pieces
    }
}

public struct SeenClock: Sendable, Equatable {
    public static let cipher = Array("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz0123456789#%&*+=/\\<>")
    static let tick = 33
    static let lockFrom = 3
    static let fadeFrom = 6

    public let at: TimeInterval
    public let on: Bool

    public init(at: TimeInterval, on: Bool) {
        self.at = at
        self.on = on
    }

    public struct State: Sendable, Equatable {
        public let locked: Int
        public let length: Int
        public let fill: Double
        public let tick: Int
    }

    public enum Look: Sendable, Equatable {
        case person, model
        case moving(State)
    }

    static var decrypt: Int { ms(Cockpit.Duration.decrypt) }
    static var stagger: Int { ms(Cockpit.Duration.decryptStagger) }
    static var glide: Int { ms(Cockpit.Duration.base) }
    static func ms(_ seconds: Double) -> Int { Int((seconds * 1000).rounded()) }

    static var lasts: Int { max(decrypt, glide, decrypt * fadeFrom / 10 + glide) }

    public func settles(_ count: Int) -> TimeInterval {
        at + Double(max(0, count - 1) * Self.stagger + Self.lasts) / 1000
    }

    public func elapsed(_ index: Int, at now: TimeInterval) -> Int {
        Self.ms(now - at) - index * Self.stagger
    }

    public func look(_ index: Int, from: Int, to: Int, at now: TimeInterval) -> Look {
        let ms = elapsed(index, at: now)
        if ms < 0 { return on ? .person : .model }
        if ms >= Self.lasts { return on ? .model : .person }
        return .moving(state(ms, from: from, to: to))
    }

    public func state(_ ms: Int, from: Int, to: Int) -> State {
        let d = Self.decrypt
        let locked = ms * 10 <= Self.lockFrom * d ? 0 : min(to, (ms * 10 - Self.lockFrom * d) * to / ((10 - Self.lockFrom) * d))
        let glided = Self.ease(min(1, Double(ms) / Double(Self.glide)))
        let length = ms >= Self.glide ? to : Int((Double(from) + Double(to - from) * glided).rounded())
        let fill: Double
        if on {
            fill = glided
        } else {
            let fading = ms - d * Self.fadeFrom / 10
            fill = fading <= 0 ? 1 : 1 - Self.ease(min(1, Double(fading) / Double(Self.glide)))
        }
        return State(locked: min(locked, length), length: length, fill: fill, tick: ms / Self.tick)
    }

    static func scrambled(_ count: Int, detail: Int, tick: Int, from: Int) -> String {
        String((0..<max(0, count)).map { place in
            var seed = UInt64(truncatingIfNeeded: detail &* 0x9E37_79B9 &+ (from + place) &* 0x85EB_CA6B &+ tick &* 0xC2B2_AE35)
            seed ^= seed >> 33
            seed &*= 0xFF51_AFD7_ED55_8CCD
            seed ^= seed >> 33
            return cipher[Int(seed % UInt64(cipher.count))]
        })
    }

    static func ease(_ t: Double) -> Double {
        guard t > 0 else { return 0 }
        guard t < 1 else { return 1 }
        let (x1, y1, x2, y2) = (0.2, 0.0, 0.0, 1.0)
        func bezier(_ s: Double, _ a: Double, _ b: Double) -> Double {
            3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * b + s * s * s
        }
        var low = 0.0
        var high = 1.0
        for _ in 0..<24 {
            let mid = (low + high) / 2
            if bezier(mid, x1, x2) < t { low = mid } else { high = mid }
        }
        return bezier((low + high) / 2, y1, y2)
    }
}

struct SeenShowing {
    enum Kind { case chip, plain }

    let now: TimeInterval
    let on: Bool
    let clock: SeenClock?
    let size: CGFloat

    func look(_ index: Int, from: String, to: String) -> SeenClock.Look {
        guard let clock else { return on ? .model : .person }
        return clock.look(index, from: from.count, to: to.count, at: now)
    }

    func text(_ index: Int, person: String, model: String, kind: Kind, look: SeenClock.Look) -> Text {
        switch look {
        case .person:
            return Text(verbatim: person)
        case .model:
            return kind == .chip ? filled(placeholder(model, whole: model), fill: 1, index: index) : Text(verbatim: model)
        case .moving(let state):
            let target = clock?.on == false ? person : model
            let head = String(target.prefix(state.locked))
            let tail = SeenClock.scrambled(state.length - state.locked, detail: index, tick: state.tick, from: state.locked)
            let toChip = kind == .chip && clock?.on == true
            let headText = toChip ? placeholder(head, whole: target) : Text(verbatim: head)
            let moving = Text("\(headText)\(Text(verbatim: tail).font(mono).foregroundColor(Cockpit.Color.textTertiary))")
            return kind == .chip ? filled(moving, fill: state.fill, index: index) : moving
        }
    }

    var mono: Font { .system(size: size * 0.86, design: .monospaced) }

    private func placeholder(_ shown: String, whole: String) -> Text {
        let bracketed = whole.hasPrefix("[[") && whole.hasSuffix("]]") && whole.count > 4
        var text = Text("")
        for (place, character) in shown.enumerated() {
            let edge = bracketed && (place < 2 || place >= whole.count - 2)
            let piece = Text(verbatim: character == " " ? "\u{00A0}" : String(character)).font(mono)
                .foregroundColor(edge ? Cockpit.Color.textTertiary : Cockpit.Color.text)
            text = Text("\(text)\(piece)")
        }
        return text
    }

    private func filled(_ words: Text, fill: Double, index: Int) -> Text {
        guard #available(macOS 15, *) else { return words }
        let pad = Self.pad * fill
        let mark = SeenFill(id: index, fill: fill, size: size)
        let before = Text("\u{202F}").font(mono).kerning(pad - Self.narrow * size * 0.86)
        let after = Text("\u{202F}").font(mono).kerning(pad - Self.narrow * size * 0.86)
        return Text("\(before)\(words)\(after)").customAttribute(mark)
    }

    static let pad: CGFloat = 2
    static let narrow: CGFloat = 0.115
}

@available(macOS 15, *)
struct SeenFill: TextAttribute {
    let id: Int
    let fill: Double
    let size: CGFloat

    static let top: CGFloat = 0.92
    static let bottom: CGFloat = 0.28
    static let side: CGFloat = 1
    static let corner: CGFloat = 4

    static func draw(_ layout: Text.Layout, in context: inout GraphicsContext) {
        for line in layout {
            var group: [Text.Layout.Run] = []
            func close() {
                guard let mark = group.first?[SeenFill.self], mark.fill > 0 else { return group = [] }
                let width = group.map(\.typographicBounds.rect).reduce(CGRect.null) { $0.union($1) }
                let baseline = group[0].typographicBounds.origin.y
                let rect = CGRect(x: width.minX - side, y: baseline - top * mark.size,
                                  width: width.width + side * 2, height: (top + bottom) * mark.size)
                var faded = context
                faded.opacity = mark.fill
                faded.fill(RoundedRectangle(cornerRadius: corner, style: .continuous).path(in: rect), with: .color(Cockpit.Color.pressed))
                group = []
            }
            for run in line {
                if let mark = run[SeenFill.self], let first = group.first?[SeenFill.self], first.id == mark.id {
                    group.append(run)
                    continue
                }
                close()
                if run[SeenFill.self] != nil { group = [run] }
            }
            close()
        }
    }
}

@available(macOS 15, *)
struct SeenRenderer: TextRenderer {
    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        SeenFill.draw(layout, in: &context)
        for line in layout { context.draw(line) }
    }
}

struct SeenWords: View {
    let words: String
    let spans: [AskSeen.Span]?
    let on: Bool
    let clock: SeenClock?
    let size: CGFloat

    var body: some View {
        if let spans, AskSeen.fits(words, spans) {
            TimelineView(AskFrames(until: clock?.settles(spans.count) ?? 0)) { context in
                drawn(spans, at: context.date.timeIntervalSinceReferenceDate)
            }
        } else {
            Text(verbatim: words)
        }
    }

    @ViewBuilder private func drawn(_ spans: [AskSeen.Span], at now: TimeInterval) -> some View {
        let showing = SeenShowing(now: now, on: on, clock: clock, size: size)
        let whole = AskSeen.pieces(words, spans).reduce(Text("")) { whole, piece in
            guard let index = piece.span else { return Text("\(whole)\(Text(verbatim: piece.words))") }
            let span = spans[index]
            let look = showing.look(index, from: piece.words, to: span.said)
            return Text("\(whole)\(showing.text(index, person: piece.words, model: span.said, kind: span.kind == .placeholder ? .chip : .plain, look: look))")
        }
        if #available(macOS 15, *) {
            whole.textRenderer(SeenRenderer())
        } else {
            whole
        }
    }
}

struct SeenFlip: ViewModifier {
    let on: Bool
    @Binding var clock: SeenClock?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        Group {
            if reduceMotion {
                content
                    .contentTransition(.opacity)
                    .animation(.easeInOut(duration: Cockpit.Duration.fast), value: on)
            } else {
                content
            }
        }
        .onChange(of: on) { _, on in
            clock = reduceMotion ? nil : SeenClock(at: AskTrace.now, on: on)
        }
    }
}

public struct SeenText: View {
    let text: String
    let role: Cockpit.Role
    @Environment(\.cockpitPlatform) private var platform

    public init(_ text: String, role: Cockpit.Role = .body) {
        self.text = text
        self.role = role
    }

    public var body: some View {
        SeenWords(words: text, spans: Self.placeholders(text), on: true, clock: nil, size: platform.style(role).size)
            .cockpit(role)
    }

    static func placeholders(_ text: String) -> [AskSeen.Span] {
        text.ranges(of: /\[\[[^\[\]\n]+\]\]/).map { found in
            .placeholder(found.lowerBound.utf16Offset(in: text), found.upperBound.utf16Offset(in: text), String(text[found]))
        }
    }
}

public struct SeenEye: View {
    let on: Bool
    let toggle: () -> Void
    @Environment(\.cockpitPlatform) private var platform

    public init(on: Bool, toggle: @escaping () -> Void) {
        self.on = on
        self.toggle = toggle
    }

    public static let name = "What the model saw"
    public static let tip = "Show what the model saw"

    public var body: some View {
        let phone = platform == .ios
        let height = phone ? Cockpit.Size.composerControl : 28
        Button(action: toggle) {
            HStack(spacing: 0) {
                Icon(.visible, size: phone ? .md : .sm)
                Text(Self.name)
                    .cockpit(.footnote)
                    .fixedSize()
                    .padding(.leading, Cockpit.Space.s1 + 2)
                    .frame(width: on ? nil : 0, alignment: .leading)
                    .clipped()
                    .opacity(on ? 1 : 0)
            }
            .padding(.leading, on ? (phone ? Cockpit.Space.s2 : 7) : 0)
            .padding(.trailing, on ? (phone ? Cockpit.Space.s3 : 9) : 0)
            .frame(minWidth: height, minHeight: height)
            .foregroundStyle(on ? Cockpit.Color.text : Cockpit.Color.textTertiary)
            .background(RoundedRectangle(cornerRadius: Cockpit.Radius.control, style: .continuous)
                .fill(on ? Cockpit.Color.selection : Color.clear))
            .contentShape(RoundedRectangle(cornerRadius: Cockpit.Radius.control, style: .continuous))
        }
        .buttonStyle(.plain)
        .animation(Cockpit.Ease.out(Cockpit.Duration.slow), value: on)
        .help(on ? "" : Self.tip)
        .accessibilityLabel(Self.name)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("ask.seen")
    }
}
