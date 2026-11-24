import SwiftUI

public struct StayHead: View {
    public enum State: Sendable { case folded, open, pinned }

    public struct NameIt {
        let identifier: String?
        let action: () -> Void

        public init(identifier: String? = nil, action: @escaping () -> Void) {
            self.identifier = identifier
            self.action = action
        }
    }

    let name: String
    let time: String?
    let length: String?
    let glyph: Cockpit.Icon?
    let line: Arriving?
    let state: State
    let rail: DayRail
    let action: (() -> Void)?
    let openEvery: (() -> Void)?
    let quiet: Bool
    let held: (@Sendable (Bool) -> Void)?
    let tight: Bool
    let pressing: ((Bool) -> Void)?
    let unnamed: Bool
    let nameIt: NameIt?
    let identifier: String?
    var forced: RowHighlight?
    @Environment(\.dynamicTypeSize) private var typeSize

    public init(_ name: String, time: String?, length: String?, glyph: Cockpit.Icon?, line: Arriving? = nil,
                state: State = .folded, rail: DayRail = .through, quiet: Bool = false, unnamed: Bool = false, tight: Bool = false,
                held: (@Sendable (Bool) -> Void)? = nil, pressing: ((Bool) -> Void)? = nil, identifier: String? = nil,
                nameIt: NameIt? = nil, action: (() -> Void)? = nil, openEvery: (() -> Void)? = nil) {
        self.unnamed = unnamed
        self.nameIt = unnamed ? nameIt : nil
        self.identifier = identifier
        self.pressing = pressing
        self.quiet = quiet
        self.tight = tight
        self.held = held
        self.name = name
        self.time = time
        self.length = length
        self.glyph = glyph
        self.line = line
        self.state = state
        self.rail = rail
        self.action = action
        self.openEvery = openEvery
    }

    public var body: some View {
        let measure = DayMeasure(size: typeSize)
        let open = state != .folded
        Group {
            if let action {
                Button(action: action) { face(measure) }
                    .buttonStyle(DayPress(forced: forced, radius: pressing == nil ? Cockpit.Radius.sm : 0, pressing: pressing))
                    .accessibilityValue(open ? "Expanded" : "Collapsed")
                    .accessibilityAction(named: open ? "Fold" : "Open", action)
            } else {
                face(measure)
            }
        }
        .accessibilityLabel(unnamed ? Spoken.join(name, line?.said, time, length.map(Spoken.read))
                                    : Spoken.join(name, time, length.map(Spoken.read), line?.said))
        .accessibilityAddTraits(.isHeader)
        .modifier(Identified(identifier: identifier))
        .modifier(OpenEvery(action: openEvery, open: open))
        .overlayPreferenceValue(NameItSlot.self) { slot in
            if let slot, let nameIt {
                GeometryReader { proxy in
                    let words = proxy[slot]
                    Button(action: nameIt.action) { Color.clear.contentShape(Rectangle()) }
                        .buttonStyle(.plain)
                        .frame(width: words.width, height: words.height + 2 * Cockpit.Space.s3)
                        .position(x: words.midX, y: words.midY)
                        .accessibilityLabel("Name it")
                        .modifier(Identified(identifier: nameIt.identifier))
                }
            }
        }
    }

    private struct Lines {
        let name: CGFloat
        let length: CGFloat
        let line: CGFloat
        let height: CGFloat
        let mark: CGFloat
        let lined: Bool

        init(_ m: DayMeasure, head: StayHead) {
            lined = head.line != nil || head.unnamed
            name = m.timeLine + m(!lined && !head.tight ? 32 : 29)
            mark = name - m.capHeight(head.nameStyle) / 2
            length = name + m(22)
            line = m.stacked && head.length != nil ? length + m(22) : length
            let last = lined ? line : m.stacked && head.length != nil ? length : name
            height = last + (head.tight ? m(6) : lined || m.stacked ? m(17) : m(20))
        }
    }

    var nameStyle: Cockpit.TextStyle {
        quiet ? Cockpit.Style.iosBody : unnamed ? Cockpit.Style.iosSubhead : Cockpit.Style.iosHeadline
    }

    private func lengthText(_ length: String) -> some View {
        Text(length)
            .cockpit(Cockpit.Style.iosSubhead)
            .monospacedDigit()
            .foregroundStyle(Cockpit.Color.textSecondary)
            .lineLimit(1)
            .fixedSize()
    }

    private func face(_ m: DayMeasure) -> some View {
        let at = Lines(m, head: self)
        let nameBaseline = at.name, lengthBaseline = at.length, mark = at.mark
        return ZStack(alignment: .topLeading) {
            Color.clear.frame(height: at.height)
            if let time {
                let shown = DayTime(time: time, tone: Cockpit.Color.textSecondary, measure: m, stackedAt: DayLattice.lead)
                if m.stacked { shown.onBaseline(m(12, .caption)) } else { shown.onCapCentre(mark, Cockpit.Style.phoneTime, m) }
            }
            if let glyph {
                StayDisc(glyph: glyph, hollow: unnamed).padding(.leading, DayLattice.rail - DayLattice.railWidth / 2).onCentre(mark)
            }
            let trailing = DayLattice.beforeCaret
            HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s4) {
                Text(name)
                    .cockpit(nameStyle)
                    .foregroundStyle(glyph == nil || unnamed ? Cockpit.Color.textSecondary : Cockpit.Color.text)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let length, !m.stacked { lengthText(length).capsWith(nameStyle, own: Cockpit.Style.iosSubhead, m) }
            }
            .column(quiet && time == nil ? Cockpit.Gap.edge : DayLattice.lead, trailing: trailing)
            .onBaseline(nameBaseline)
            if let length, m.stacked { lengthText(length).column(DayLattice.lead).onBaseline(lengthBaseline) }
            if line != nil || nameIt != nil {
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    if let line {
                        ArrivingText(line: line, style: Cockpit.Style.iosSubhead, tone: Cockpit.Color.textSecondary)
                            .cockpitLines(1)
                    }
                    if nameIt != nil {
                        Text(line?.said?.isEmpty == false ? " \u{00B7} " : "")
                            .cockpit(Cockpit.Style.iosSubhead)
                            .foregroundStyle(Cockpit.Color.textSecondary)
                            .fixedSize()
                        Text("Name it")
                            .cockpit(Cockpit.Style.iosSubhead)
                            .foregroundStyle(Cockpit.Color.here)
                            .fixedSize()
                            .anchorPreference(key: NameItSlot.self, value: .bounds) { $0 }
                    }
                }
                .padding(.bottom, m.stacked ? m(6, .footnote) : 0)
                .column(DayLattice.lead, trailing: DayLattice.trailing)
                .onBaseline(at.line)
            }
            if action != nil { DayCaret(open: state != .folded).onCentre(mark) }
        }
        .frame(maxWidth: .infinity)
        .background(alignment: .bottom) {
            if state == .pinned {
                pinGround
            } else if state == .open, let held {
                pinGround.visualEffect { effect, proxy in
                    let pinned = proxy.frame(in: .scrollView).minY < 0.5
                    held(pinned)
                    return effect.opacity(pinned ? 1 : 0)
                }
            }
        }
        .dayRail(rail, mark: mark)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
    }

    private var pinGround: some View {
        Cockpit.Color.canvas
            .overlay(alignment: .bottom) { Cockpit.Color.rule.frame(height: Cockpit.pixelRule) }
            .padding(.top, -Cockpit.Space.s8)
            .allowsHitTesting(false)
    }
}

struct StayDisc: View {
    let glyph: Cockpit.Icon
    var hollow = false
    @Environment(\.redactionReasons) private var redaction
    @Environment(\.skeletonTone) private var tone

    static let dot: CGFloat = 10

    var body: some View {
        let ink = redaction.skeleton ? tone : Cockpit.Color.textSecondary
        ZStack {
            RailGround().frame(width: Self.dot + 8, height: Self.dot + 8)
            if hollow {
                Circle().strokeBorder(ink, lineWidth: Cockpit.Stroke.line).frame(width: Self.dot, height: Self.dot)
            } else {
                Circle().fill(ink).frame(width: Self.dot, height: Self.dot)
            }
        }
        .frame(width: DayLattice.railWidth, height: DayLattice.railWidth)
        .accessibilityHidden(true)
    }
}

private struct NameItSlot: PreferenceKey {
    static var defaultValue: Anchor<CGRect>? { nil }

    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
        value = value ?? nextValue()
    }
}

private struct Identified: ViewModifier {
    let identifier: String?

    func body(content: Content) -> some View {
        if let identifier { content.accessibilityIdentifier(identifier) } else { content }
    }
}

private struct OpenEvery: ViewModifier {
    let action: (() -> Void)?
    let open: Bool

    func body(content: Content) -> some View {
        if let action {
            content.accessibilityAction(named: open ? "Fold every stay" : "Open every stay", action)
        } else {
            content
        }
    }
}
