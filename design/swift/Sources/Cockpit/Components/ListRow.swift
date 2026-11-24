import SwiftUI

public struct ListRow<Trailing: View>: View {
    public enum Leading: Sendable {
        case none
        case blank
        case icon(Cockpit.Icon)
        case symbol(Cockpit.Icon)
        case monogram(String?, photo: Image? = nil)
        case tile(Cockpit.Icon, picture: Image? = nil)
        case signal(Cockpit.SignalKind, word: String)
        case need(Cockpit.Icon, word: String)
    }

    public struct Glyph: Sendable {
        let icon: Cockpit.Icon
        let word: String

        public init(_ icon: Cockpit.Icon, _ word: String) {
            self.icon = icon
            self.word = word
        }
    }

    public struct Excerpt: Sendable, Equatable {
        public struct Run: Sendable, Equatable {
            public let text: String
            public let marked: Bool

            public init(_ text: String, marked: Bool = false) {
                self.text = text
                self.marked = marked
            }
        }

        public let runs: [Run]

        public init(_ runs: [Run]) {
            self.runs = runs
        }

        public init(_ words: String) {
            runs = [Run(words)]
        }

        public var words: String { runs.map(\.text).joined() }
    }

    public enum Control {
        case add(String, perform: () -> Void)
        case act(String, busy: Bool, id: String? = nil, perform: (() -> Void)? = nil)
        case lead(String, perform: () -> Void)
    }

    let title: String
    let wraps: Bool
    let about: String?
    let glyphs: [Glyph]
    let here: Bool
    let meta: String?
    let metaReading: Bool
    let mono: Bool
    let tag: String?
    let signal: Cockpit.SignalKind?
    let recording: Bool
    let voice: String?
    let detail: String?
    let excerpt: Excerpt?
    let lines: Int
    let area: String?
    let leading: Leading
    let known: Bool
    let value: String?
    let when: String?
    let stamp: String?
    let chevron: Bool?
    let selected: Bool
    let separator: Bool
    let control: Control?
    let action: (() -> Void)?
    let trailing: Trailing
    var forced: RowHighlight?
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.isEnabled) private var enabled

    public init(_ title: String, wraps: Bool = false, about: String? = nil, glyphs: [Glyph] = [], here: Bool = false, meta: String? = nil,
                metaReading: Bool = false, mono: Bool = false, tag: String? = nil, signal: Cockpit.SignalKind? = nil, recording: Bool = false, voice: String? = nil, detail: String? = nil,
                excerpt: Excerpt? = nil, lines: Int = 1, area: String? = nil,
                leading: Leading = .none, known: Bool = false, value: String? = nil, when: String? = nil, stamp: String? = nil, chevron: Bool? = nil,
                selected: Bool = false, separator: Bool = true, control: Control? = nil, action: (() -> Void)? = nil,
                @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.wraps = wraps
        self.about = about
        self.glyphs = glyphs
        self.here = here
        self.meta = meta
        self.metaReading = metaReading
        self.mono = mono
        self.tag = tag
        self.signal = signal
        self.recording = recording
        self.voice = voice
        self.detail = detail
        self.excerpt = excerpt
        self.lines = lines
        self.area = area
        self.leading = leading
        self.known = known
        self.value = value
        self.when = when
        self.stamp = stamp
        self.chevron = chevron
        self.selected = selected
        self.separator = separator
        self.control = control
        self.action = action
        self.trailing = trailing()
    }

    public var body: some View {
        row
            .modifier(ControlAction(control: control, action: action))
            .overlay(alignment: .trailing) {
                if let control {
                    Self.button(control, row: action)
                        .padding(.trailing, inset)
                        .accessibilityHidden(!Self.isOwn(control))
                        .allowsHitTesting(!(platform == .ios && Self.isRows(control)))
                }
            }
    }

    @ViewBuilder private var row: some View {
        if let action {
            Button(action: action) { content }
                .buttonStyle(Cockpit.Pressable.row(platform, selected: selected, forced: forced))
                .accessibilityAddTraits(selected ? .isSelected : [])
        } else {
            RowChrome(radius: platform.rowRadius, highlight: forced ?? (selected ? .selected : nil)) { content }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(selected ? .isSelected : [])
        }
    }

    private var spacing: CGFloat {
        if platform == .ios, flat, let faces, faces < Self.avatar, onIcon { return Cockpit.Space.s3 }
        if platform == .ios, close { return Cockpit.Space.s2 }
        return platform == .ios ? Cockpit.Space.s4 : Cockpit.Space.s2
    }
    private var endShape: Bool { platform == .ios && column > 0 }
    private var onIcon: Bool {
        switch leading {
        case .icon, .symbol, .need, .blank: true
        default: false
        }
    }
    static var hereDot: CGFloat { 7 }
    private var inset: CGFloat { platform.rowInset }
    @Environment(\.cockpitRowsFlat) private var flat
    @Environment(\.cockpitRowsBare) private var bare
    @Environment(\.cockpitRowActs) private var acts
    @Environment(\.cockpitRowWarns) private var warns
    @Environment(\.cockpitRowQuiet) private var quiet
    @Environment(\.inSettingSection) private var inSection
    private var sectioned: Bool { inSection && platform == .ios }
    @Environment(\.cockpitRowsFaces) private var faces
    @Environment(\.cockpitRowsClose) private var close
    @Environment(\.cockpitSheetScale) private var sheetScale
    private var leadBack: CGFloat { column > 0 ? (column + spacing) * (1 / sheetScale - 1) : 0 }
    private func ink(_ color: Color) -> Color { enabled ? color : Cockpit.Color.textDisabled }

    private var showsChevron: Bool {
        if let chevron { return chevron }
        return platform == .ios && action != nil && !bare && !acts && !warns && control == nil && value == nil && when == nil
            && Trailing.self == EmptyView.self
    }

    private var metaInk: Color { quiet ? Cockpit.Color.textTertiary : Cockpit.Color.textSecondary }

    private var unnamed: Bool { if case .monogram(nil, _) = leading { true } else { false } }
    private var sentence: Bool { signalWord != nil }
    private var signalWord: String? {
        switch leading {
        case let .signal(_, word), let .need(_, word): word
        default: nil
        }
    }

    private var content: some View {
        HStack(spacing: spacing) {
            leadingView
                .unredacted(when: known)
                .padding(.trailing, leadBack)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(title.breakingAddresses)
                        .cockpit(sectioned ? Cockpit.Style.iosRowTitle : platform.style(.rowTitle))
                        .foregroundStyle(ink(warns ? Cockpit.Color.warning : acts ? Cockpit.Color.accent : unnamed || quiet ? Cockpit.Color.textSecondary : Cockpit.Color.text))
                        .cockpitLines(sentence || wraps ? nil : 1)
                        .unredacted(when: known)
                        .accessibilityLabel(([signalWord, title].compactMap { $0 } + glyphs.map(\.word) + [area].compactMap { $0 } + (here ? ["You're here"] : []))
                            .joined(separator: ", "))
                    ForEach(glyphs.indices, id: \.self) { index in
                        Icon(glyphs[index].icon, size: .xs)
                            .foregroundStyle(ink(Cockpit.Color.textTertiary))
                    }
                    if here {
                        Circle()
                            .fill(Cockpit.Color.here)
                            .frame(width: Self.hereDot, height: Self.hereDot)
                            .accessibilityHidden(true)
                    }
                    if let about { InfoMark(about, label: title) }
                    if let stamp {
                        Spacer(minLength: Cockpit.Space.s2)
                        Text(stamp)
                            .cockpit(.subhead)
                            .monospacedDigit()
                            .foregroundStyle(ink(Cockpit.Color.textTertiary))
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
                if meta != nil || signal != nil || tag != nil {
                    let follows = endShape
                    let shape = recording ? .engaged : signal
                    HStack(spacing: 6) {
                        if let shape, !follows {
                            SignalShape(shape, size: platform == .ios ? 12 : 10, pulse: shape == .engaged)
                                .opacity(enabled ? 1 : Cockpit.Opacity.disabled)
                        }
                        Group {
                            if let meta, platform == .ios, !sectioned, !sentence, lines == 1, meta.contains(" · ") {
                                WholeFacts(facts: meta, tone: ink(metaInk))
                                    .accessibilityLabel(recording ? meta + ", Recording" : meta)
                            } else if let meta {
                                Text(meta.breakingAddresses)
                                    .cockpit(sectioned ? Cockpit.Style.iosFootnote : platform.style(mono && platform == .mac ? .monoData : .subhead))
                                    .monospacedDigit()
                                    .foregroundStyle(ink(metaInk))
                                    .cockpitLines(sentence ? nil : lines)
                                    .accessibilityLabel(recording ? meta + ", Recording" : meta)
                            }
                        }
                        .reading(metaReading)
                        if let tag { Tag(tag).fixedSize() }
                    }
                }
                if let excerpt {
                    Self.excerptText(excerpt, ink: ink)
                        .cockpit(platform.style(.subhead))
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if let voice {
                    Text("\u{201C}\(voice)\u{201D}")
                        .cockpit(.voice)
                        .foregroundStyle(ink(Cockpit.Color.textSecondary))
                        .cockpitLines(2)
                }
                if let detail {
                    Text(detail)
                        .cockpit(platform == .ios ? .subhead : .monoData)
                        .foregroundStyle(ink(Cockpit.Color.textTertiary))
                        .cockpitLines(lines)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let value {
                Text(value)
                    .cockpit(platform == .ios ? .body : .monoData)
                    .monospacedDigit()
                    .foregroundStyle(ink(Cockpit.Color.textSecondary))
                    .lineLimit(1)
                    .fixedSize()
            }
            if let when {
                Text(when)
                    .cockpit(platform == .ios ? .body : .footnote)
                    .foregroundStyle(ink(platform == .ios ? Cockpit.Color.textSecondary : Cockpit.Color.textTertiary))
                    .lineLimit(1)
                    .fixedSize()
            }
            trailing
            if endShape, control == nil, let shape = recording ? .engaged : signal {
                SignalShape(shape, size: 12, pulse: shape == .engaged)
                    .opacity(enabled ? 1 : Cockpit.Opacity.disabled)
            }
            if let control {
                Self.button(control, row: action).hidden().accessibilityHidden(true)
            }
            if showsChevron {
                Icon(.forward, size: platform == .ios ? .sm : .xs)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .padding(.trailing, platform == .ios ? -4 : 0)
            }
        }
        .padding(.horizontal, inset)
        .padding(.vertical, platform == .ios ? (excerpt == nil ? Cockpit.Space.s3 : Cockpit.Space.s2) : 6)
        .frame(minHeight: platform == .ios && (meta != nil || tag != nil) && !sectioned && excerpt == nil ? 68 : platform.rowHeight)
        .overlay(alignment: .bottom) {
            if separator {
                Rectangle()
                    .fill(Cockpit.Color.rule)
                    .frame(height: platform.ruleHeight)
                    .padding(.leading, inset + (column > 0 ? column + spacing : 0))
                    .padding(.trailing, sectioned ? 0 : inset)
            }
        }
        .contentShape(Rectangle())
    }

    private var column: CGFloat {
        if platform == .ios {
            if case .none = leading { return 0 }
            if case .monogram = leading { return Self.avatar }
            if case .tile = leading { return Self.avatar }
            return flat ? (onIcon ? faces : nil) ?? Self.avatar : platform.iconColumn
        }
        switch leading {
        case .none: return 0
        case .icon: return platform.iconColumn
        case .symbol, .monogram, .tile, .signal, .need, .blank: return Cockpit.Size.avatarSm
        }
    }

    static var avatar: CGFloat { Cockpit.Size.lead }

    @ViewBuilder private var leadingView: some View {
        switch leading {
        case .none:
            EmptyView()
        case .blank:
            Color.clear.frame(width: column, height: 1)
        case let .icon(meaning) where platform == .mac:
            IconTile(meaning)
                .opacity(enabled ? 1 : Cockpit.Opacity.disabled)
        case let .icon(meaning), let .symbol(meaning), let .need(meaning, _):
            Icon(meaning, size: platform == .ios ? .md : .sm)
                .foregroundStyle(ink(acts ? Cockpit.Color.accent : quiet ? Cockpit.Color.textTertiary : Cockpit.Color.textSecondary))
                .frame(width: platform == .ios ? Cockpit.Space.s6 : nil)
                .frame(width: column, alignment: platform == .ios ? (flat ? (faces == nil ? .trailing : .center) : .leading) : .center)
                .opacity(enabled ? 1 : Cockpit.Opacity.disabled)
        case let .monogram(name, photo):
            PersonFace(name, photo: photo, size: platform != .ios ? .sm : .row)
                .frame(width: column, alignment: faces == Cockpit.listFace ? .leading : .center)
                .opacity(enabled ? 1 : Cockpit.Opacity.disabled)
                .accessibilityHidden(true)
        case let .tile(meaning, picture):
            let side = platform == .ios ? Cockpit.Size.avatarRow : Cockpit.Size.avatarSm
            IconTile(meaning, side: side, ink: Cockpit.Color.textSecondary)
                .overlay {
                    if let picture {
                        picture
                            .resizable()
                            .scaledToFill()
                            .frame(width: side, height: side)
                            .clipShape(RoundedRectangle(cornerRadius: platform.tileRadius, style: .continuous))
                    }
                }
                .frame(width: column, alignment: faces == Cockpit.listFace ? .leading : .center)
                .opacity(enabled ? 1 : Cockpit.Opacity.disabled)
                .accessibilityHidden(true)
        case let .signal(kind, _):
            SignalShape(kind, size: platform == .ios ? 12 : Cockpit.Size.iconSm)
                .frame(width: column)
                .opacity(enabled ? 1 : Cockpit.Opacity.disabled)
        }
    }

    static func excerptText(_ excerpt: Excerpt, ink: (Color) -> Color) -> Text {
        excerpt.runs.reduce(Text(verbatim: "")) { words, run in
            let part = Text(verbatim: run.text)
                .foregroundStyle(ink(run.marked ? Cockpit.Color.text : Cockpit.Color.textSecondary))
                .fontWeight(run.marked ? .semibold : nil)
            return Text("\(words)\(part)")
        }
    }
}

public extension ListRow where Trailing == EmptyView {
    init(_ title: String, wraps: Bool = false, about: String? = nil, glyphs: [Glyph] = [], here: Bool = false, meta: String? = nil,
         metaReading: Bool = false, mono: Bool = false, tag: String? = nil, signal: Cockpit.SignalKind? = nil,
         recording: Bool = false, voice: String? = nil, detail: String? = nil, excerpt: Excerpt? = nil, lines: Int = 1, area: String? = nil,
         leading: Leading = .none, known: Bool = false, value: String? = nil, when: String? = nil, stamp: String? = nil, chevron: Bool? = nil,
         selected: Bool = false, separator: Bool = true, control: Control? = nil, action: (() -> Void)? = nil) {
        self.init(title, wraps: wraps, about: about, glyphs: glyphs, here: here, meta: meta, metaReading: metaReading, mono: mono, tag: tag, signal: signal, recording: recording,
                  voice: voice,
                  detail: detail, excerpt: excerpt, lines: lines, area: area,
                  leading: leading, known: known, value: value, when: when, stamp: stamp, chevron: chevron, selected: selected, separator: separator,
                  control: control, action: action) { EmptyView() }
    }
}

public struct OutRow: View {
    let title: String
    let meta: String?
    let leading: ListRow<EmptyView>.Leading
    let separator: Bool
    let action: () -> Void

    public init(_ title: String, meta: String? = nil, leading: ListRow<EmptyView>.Leading = .none, separator: Bool = true,
                action: @escaping () -> Void) {
        self.title = title
        self.meta = meta
        self.leading = leading
        self.separator = separator
        self.action = action
    }

    public var body: some View {
        ListRow(title, meta: meta, leading: Self.lead(leading), separator: separator, action: action) { OutMark() }
            .accessibilityAddTraits(.isLink)
    }

    struct OutMark: View {
        var body: some View { Icon(.openOut, size: .xs).foregroundStyle(Cockpit.Color.accent) }
    }

    private static func lead(_ leading: ListRow<EmptyView>.Leading) -> ListRow<OutMark>.Leading {
        switch leading {
        case .none: .none
        case .blank: .blank
        case let .icon(icon): .icon(icon)
        case let .symbol(icon): .symbol(icon)
        case let .monogram(name, photo): .monogram(name, photo: photo)
        case let .tile(icon, picture): .tile(icon, picture: picture)
        case let .signal(kind, word): .signal(kind, word: word)
        case let .need(icon, word): .need(icon, word: word)
        }
    }
}

private struct ControlAction<Trailing: View>: ViewModifier {
    let control: ListRow<Trailing>.Control?
    let action: (() -> Void)?
    func body(content: Content) -> some View {
        switch control {
        case nil:
            content
        case let .add(label, perform):
            content.accessibilityAction(named: Text(label), perform)
        case .act(_, _, _?, _):
            content
        case let .act(label, busy, nil, perform):
            content
                .accessibilityValue(label)
                .accessibilityAction(named: Text(label)) { if !busy { (perform ?? action)?() } }
        case let .lead(label, perform):
            content.accessibilityAction(named: Text(label), perform)
        }
    }
}

extension ListRow {
    static func isRows(_ control: Control) -> Bool { if case .act(_, _, _, .none) = control { true } else { false } }

    static func isOwn(_ control: Control) -> Bool { if case .act(_, _, _?, _) = control { true } else { false } }

    @ViewBuilder static func button(_ control: Control, row action: (() -> Void)?) -> some View {
        switch control {
        case let .add(label, perform):
            IconButton(.add, label: label, style: .raised, size: .small, action: perform)
        case let .act(label, busy, id, perform):
            Button(label, action: perform ?? action ?? {}).buttonStyle(.cockpit(.secondary, size: .small, busy: busy))
                .accessibilityIdentifier(id ?? "")
        case let .lead(label, perform):
            Button(label, action: perform).buttonStyle(.cockpit(.primary, size: .small))
        }
    }
}

public struct RowEnd: View {
    public enum Face: Equatable {
        case time(String)
        case place(String)
        case state(Cockpit.SignalKind, String)
    }

    let face: Face

    public init(_ face: Face) {
        self.face = face
    }

    public var body: some View {
        switch face {
        case let .time(words):
            Text(words)
                .cockpit(.footnote)
                .monospacedDigit()
                .foregroundStyle(Cockpit.Color.textTertiary)
                .lineLimit(1)
                .fixedSize()
        case let .place(words):
            Text(words)
                .cockpit(.footnote)
                .foregroundStyle(Cockpit.Color.textTertiary)
                .lineLimit(1)
                .fixedSize()
        case let .state(kind, word):
            Signal(kind, word)
                .fixedSize()
        }
    }
}

enum RowHighlight { case hover, pressed, selected }

extension Cockpit.Platform {
    var rowRadius: CGFloat { self == .ios ? Cockpit.Space.s3 : Cockpit.Radius.sm }
    var rowInset: CGFloat { self == .ios ? Cockpit.Space.s4 : Cockpit.Space.s3 }
    public var ruleHeight: CGFloat { self == .ios ? Cockpit.pixelRule : Cockpit.Stroke.border }
}

public extension Cockpit {
    static var pixelRule: CGFloat {
        #if os(iOS)
        1.0 / 3
        #else
        Stroke.hairline
        #endif
    }
}

struct RowChrome<Content: View>: View {
    let radius: CGFloat
    let highlight: RowHighlight?
    @ViewBuilder let content: Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .background {
                ZStack {
                    if let highlight { shape.fill(Self.color(highlight)) }
                }
                .animation(.easeOut(duration: Cockpit.Duration.instant), value: highlight)
            }
    }

    static func color(_ highlight: RowHighlight) -> Color {
        switch highlight {
        case .hover: Cockpit.Color.hover
        case .pressed: Cockpit.Color.pressed
        case .selected: Cockpit.Color.selection
        }
    }
}

public struct CardRow<Content: View>: View {
    let separator: Bool
    let lead: CGFloat
    let content: Content
    @Environment(\.cockpitPlatform) private var platform

    public init(separator: Bool = true, lead: CGFloat = 0, @ViewBuilder content: () -> Content) {
        self.separator = separator
        self.lead = lead
        self.content = content()
    }

    public var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, platform.rowInset)
            .padding(.vertical, platform == .ios ? Cockpit.Space.s3 : 6)
            .frame(minHeight: platform.rowHeight)
            .overlay(alignment: .bottom) {
                if separator {
                    Rectangle()
                        .fill(Cockpit.Color.rule)
                        .frame(height: platform.ruleHeight)
                        .padding(.horizontal, platform.rowInset)
                        .padding(.leading, lead)
                }
            }
    }
}

public extension EnvironmentValues {
    @Entry var cockpitRowActs = false
    @Entry var cockpitRowWarns = false
    @Entry var cockpitRowsBare = false
    @Entry var cockpitRowQuiet = false
}
