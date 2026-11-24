import SwiftUI
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

public enum DayLattice {
    public static let timeStart: CGFloat = 20
    public static let time: CGFloat = 60
    public static let rail: CGFloat = 66
    public static let railWidth: CGFloat = 14
    public static let ring: CGFloat = 11
    public static let nowDot: CGFloat = 5
    public static let lead: CGFloat = 76
    public static let name: CGFloat = 76
    public static let step: CGFloat = 18
    public static let trailing: CGFloat = 20
    public static let beforeCaret: CGFloat = 48
    public static let fill: CGFloat = 0
}


public struct DayRail: Sendable, Equatable {
    public enum Line: Sendable, Equatable { case life, track, plan, none }

    public var above: Line
    public var below: Line

    public init(above: Line, below: Line) {
        self.above = above
        self.below = below
    }

    public static func through(_ line: Line) -> DayRail { DayRail(above: line, below: line) }
    public static let through = DayRail.through(.life)
    public static let none = DayRail.through(.none)
    public static let starts = DayRail(above: .none, below: .life)
    public static let ends = DayRail(above: .life, below: .none)
}

public extension View {
    func dayRail(_ rail: DayRail, mark: CGFloat? = nil, opensFrom: CGFloat? = nil) -> some View {
        background(alignment: .topLeading) { RailBehind(rail: rail, mark: mark, opensFrom: opensFrom) }
    }
}

private struct RailBehind: View {
    let rail: DayRail
    let mark: CGFloat?
    let opensFrom: CGFloat?

    var body: some View {
        GeometryReader { proxy in
            let height = min(proxy.size.height, max(0, opensFrom ?? proxy.size.height))
            let split = min(max(0, mark ?? proxy.size.height / 2), height)
            ZStack(alignment: .topLeading) {
                RailStroke(line: rail.above).frame(width: Cockpit.Stroke.border, height: split)
                RailStroke(line: rail.below).frame(width: Cockpit.Stroke.border, height: height - split).offset(y: split)
            }
            .offset(x: DayLattice.rail - Cockpit.Stroke.border / 2)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct RailStroke: View {
    let line: DayRail.Line
    @Environment(\.redactionReasons) private var redaction
    @Environment(\.skeletonTone) private var tone

    var body: some View {
        switch line {
        case .life: RailPath().stroke(redaction.skeleton ? tone : Cockpit.Color.border, lineWidth: Cockpit.Stroke.border)
        case .track: RailPath().stroke(redaction.skeleton ? tone : Cockpit.Color.track, lineWidth: Cockpit.Stroke.border)
        case .plan: RailPath().stroke(Cockpit.Color.textTertiary, style: StrokeStyle(lineWidth: Cockpit.Stroke.border, dash: Cockpit.Dash.future))
        case .none: Color.clear
        }
    }
}

private struct RailPath: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.midX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
        return path
    }
}


public struct ContactRun: Hashable, Sendable {
    public let glyph: Cockpit.Icon
    public let value: String
    public let said: String
    public let written: String

    public init(_ glyph: Cockpit.Icon, _ value: String, said: String, written: String? = nil) {
        self.glyph = glyph
        self.value = value
        self.said = said
        self.written = written ?? said
    }

    public var counted: ContactRun { glyph == .call && Int(value) == nil ? .calls(1) : self }

    public static func sent(_ count: Int) -> ContactRun {
        ContactRun(.message, number(count), said: "\(number(count)) \(count == 1 ? "message" : "messages") sent")
    }

    public static func received(_ count: Int) -> ContactRun {
        ContactRun(.message, number(count), said: "\(number(count)) \(count == 1 ? "message" : "messages") received")
    }

    public static func call(_ length: String) -> ContactRun {
        ContactRun(.call, length, said: "1 call, \(Spoken.read(length))", written: "1 call \u{00B7} \(length)")
    }

    public static func calls(_ count: Int) -> ContactRun {
        ContactRun(.call, number(count), said: "\(number(count)) \(count == 1 ? "call" : "calls")")
    }

    public static func missed(_ count: Int) -> ContactRun {
        ContactRun(.callMissed, number(count), said: "\(number(count)) missed \(count == 1 ? "call" : "calls")")
    }

    static func number(_ count: Int) -> String {
        count.formatted(.number.grouping(.automatic).locale(Locale(identifier: "en_US")))
    }
}

public struct ContactRuns: View {
    let runs: [ContactRun]
    let glyph: Cockpit.IconSize
    let tone: Color
    var value: Cockpit.TextStyle = Cockpit.Style.phoneData

    public init(runs: [ContactRun], glyph: Cockpit.IconSize, tone: Color, value: Cockpit.TextStyle = Cockpit.Style.phoneData) {
        self.runs = runs
        self.glyph = glyph
        self.tone = tone
        self.value = value
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            ForEach(Array(runs.enumerated()), id: \.offset) { _, run in
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Icon(run.glyph, size: glyph)
                        .foregroundStyle(Cockpit.Color.textTertiary)
                        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4.5 }
                    Text(run.value)
                        .cockpit(value)
                        .monospacedDigit()
                        .foregroundStyle(tone)
                }
            }
        }
        .lineLimit(1)
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(runs.map(\.said).joined(separator: ", "))
    }
}


public enum Arriving: Sendable, Equatable, ExpressibleByStringLiteral {
    case words(String)
    case coming

    public init(stringLiteral value: String) {
        self = .words(value)
    }

    var said: String? {
        if case let .words(words) = self { return words }
        return nil
    }
}

struct ArrivingText: View {
    let line: Arriving
    let style: Cockpit.TextStyle
    let tone: Color

    var body: some View {
        switch line {
        case let .words(words):
            Text(words).cockpit(style).foregroundStyle(tone)
        case .coming:
            Text("Two words").cockpit(style).foregroundStyle(tone).lineLimit(1).reading(true)
        }
    }
}


extension View {
    func onBaseline(_ y: CGFloat) -> some View {
        alignmentGuide(.top) { $0[.firstTextBaseline] - y }
    }

    func onCentre(_ y: CGFloat) -> some View {
        alignmentGuide(.top) { $0[VerticalAlignment.center] - y }
    }

    func onCapCentre(_ y: CGFloat, _ style: Cockpit.TextStyle, _ m: DayMeasure) -> some View {
        let half = m.capHeight(style) / 2
        return alignmentGuide(.top) { $0[.firstTextBaseline] - y - half }
    }

    func capsWith(_ line: Cockpit.TextStyle, own style: Cockpit.TextStyle, _ m: DayMeasure) -> some View {
        let shift = (m.capHeight(line) - m.capHeight(style)) / 2
        return alignmentGuide(.firstTextBaseline) { $0[.firstTextBaseline] + shift }
    }

    func onCaps(_ style: Cockpit.TextStyle, _ m: DayMeasure) -> some View {
        let half = m.capHeight(style) / 2
        return alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + half }
    }

    func column(_ leading: CGFloat, trailing: CGFloat = DayLattice.trailing, alignment: Alignment = .leading) -> some View {
        frame(maxWidth: .infinity, alignment: alignment)
            .padding(.leading, leading)
            .padding(.trailing, trailing)
    }
}

struct DayMeasure {
    let size: DynamicTypeSize

    func callAsFunction(_ value: CGFloat, _ style: Font.TextStyle = .subheadline) -> CGFloat {
        Cockpit.scaled(value, relativeTo: style, at: size)
    }

    var stacked: Bool { size.isAccessibilitySize }
    var timeLine: CGFloat { stacked ? self(16, .caption) : 0 }

    func capHeight(_ style: Cockpit.TextStyle) -> CGFloat {
        let points = style.textStyle.map { Cockpit.scaled(style.size, relativeTo: $0, at: size) } ?? style.size
        #if canImport(UIKit)
        return UIFont.systemFont(ofSize: points).capHeight
        #else
        return NSFont.systemFont(ofSize: points).capHeight
        #endif
    }
}

struct DayTime: View {
    let time: String
    var tone: Color = Cockpit.Color.textTertiary
    var weight: Font.Weight?
    let measure: DayMeasure
    let stackedAt: CGFloat

    var body: some View {
        Text(time)
            .cockpit(Cockpit.Style.phoneTime)
            .fontWeight(weight)
            .monospacedDigit()
            .foregroundStyle(tone)
            .lineLimit(1)
            .fixedSize()
            .frame(width: measure.stacked ? nil : DayLattice.time - DayLattice.timeStart, alignment: .leading)
            .padding(.leading, measure.stacked ? stackedAt : DayLattice.timeStart)
    }
}

struct DayCaret: View {
    let open: Bool
    @Environment(\.cockpitPlatform) private var platform

    var body: some View {
        Icon(.forward, size: .sm)
            .foregroundStyle(Cockpit.Color.textTertiary)
            .rotationEffect(.degrees(open ? 90 : 0))
            .column(0, trailing: DayLattice.trailing, alignment: .trailing)
            .offset(x: platform == .ios ? (open ? 2 : 4.3) : 0)
    }
}

struct LeadCaret: View {
    let open: Bool

    var body: some View {
        Icon(.forward, size: .xs)
            .foregroundStyle(Cockpit.Color.textTertiary)
            .rotationEffect(.degrees(open ? 90 : 0))
            .frame(width: DayLattice.step, alignment: .leading)
    }
}

struct DayPress: ButtonStyle {
    var selected = false
    var forced: RowHighlight?
    var radius: CGFloat = Cockpit.Radius.sm
    var inset: CGFloat = DayLattice.fill
    var pressing: ((Bool) -> Void)?

    func makeBody(configuration: Configuration) -> some View {
        Cockpit.Pressable(selected: selected, forced: forced) { label, state in
            DayFill(highlight: state, radius: radius, inset: inset) { label }
        }
        .makeBody(configuration: configuration)
        .onChange(of: configuration.isPressed) { _, held in pressing?(held) }
    }
}

public extension View {
    func dayBand(_ held: Bool) -> some View {
        DayFill(highlight: held ? .pressed : nil, radius: 0) { self }
    }
}

extension EnvironmentValues {
    @Entry var dayHighlight: RowHighlight?
}

struct RailGround: View {
    @Environment(\.dayHighlight) private var highlight

    var body: some View {
        Circle().fill(Cockpit.Color.canvas)
            .overlay { if let highlight { Circle().fill(RowChrome<EmptyView>.color(highlight)) } }
    }
}

struct DayFill<Content: View>: View {
    let highlight: RowHighlight?
    var radius: CGFloat = Cockpit.Radius.sm
    var inset: CGFloat = DayLattice.fill
    @ViewBuilder let content: Content
    @Environment(\.cockpitPlatform) private var platform

    var body: some View {
        content.environment(\.dayHighlight, highlight).background {
            ZStack {
                if let highlight {
                    RoundedRectangle(cornerRadius: platform == .ios && inset == 0 ? 0 : radius, style: .continuous)
                        .fill(RowChrome<EmptyView>.color(highlight))
                        .padding(.horizontal, inset)
                }
            }
            .animation(.easeOut(duration: Cockpit.Duration.instant), value: highlight)
            .accessibilityHidden(true)
        }
    }
}

struct Offered<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        ViewThatFits(in: .vertical) {
            content
            Color.clear.frame(width: 0, height: 0)
        }
    }
}
