import SwiftUI

public extension Cockpit {
    enum SignalKind: String, CaseIterable, Sendable {
        case engaged
        case idle
        case now
        case plan
        case caution
        case warning

        public var color: SwiftUI.Color {
            switch self {
            case .engaged: Cockpit.Color.engaged
            case .idle: Cockpit.Color.textTertiary
            case .now: Cockpit.Color.now
            case .plan: Cockpit.Color.plan
            case .caution: Cockpit.Color.caution
            case .warning: Cockpit.Color.warning
            }
        }

        public var soft: SwiftUI.Color {
            switch self {
            case .engaged: Cockpit.Color.engagedSoft
            case .idle: Cockpit.Color.raised
            case .now: Cockpit.Color.nowSoft
            case .plan: Cockpit.Color.planSoft
            case .caution: Cockpit.Color.cautionSoft
            case .warning: Cockpit.Color.warningSoft
            }
        }

        var wordColor: SwiftUI.Color {
            switch self {
            case .engaged: Cockpit.Color.text
            case .idle, .plan: Cockpit.Color.textSecondary
            case .now, .caution, .warning: color
            }
        }
    }
}

public struct SignalShape: View {
    let kind: Cockpit.SignalKind
    let size: CGFloat
    let pulse: Bool
    @Environment(\.cockpitPlatform) private var platform

    public init(_ kind: Cockpit.SignalKind, size: CGFloat = 12, pulse: Bool = false) {
        self.kind = kind
        self.size = size
        self.pulse = pulse
    }

    public var body: some View {
        let ink = kind.color
        let line: CGFloat = 1.5
        ZStack {
            switch kind {
            case .engaged:
                if pulse { BreathRing(color: ink, scale: 2.1, from: 0.45, filled: true).frame(width: size * 0.68, height: size * 0.68) }
                Circle().fill(ink).frame(width: size * 0.68, height: size * 0.68)
            case .idle:
                let ring = platform == .ios ? size * 0.84 + line : size * 0.62
                Circle().strokeBorder(ink, lineWidth: line).frame(width: ring, height: ring)
            case .now:
                Circle().strokeBorder(ink, lineWidth: line).frame(width: size * 0.92, height: size * 0.92)
                Circle().fill(ink).frame(width: size * 0.44, height: size * 0.44)
            case .plan:
                Circle().strokeBorder(ink, style: StrokeStyle(lineWidth: line, dash: [2, 2])).frame(width: size * 0.8, height: size * 0.8)
            case .caution:
                MarkGlyph(.needs, size: size, ink: ink)
            case .warning:
                MarkGlyph(.stopped, size: size, ink: ink)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

public extension Cockpit {
    enum Severity: String, CaseIterable, Sendable {
        case stopped, needs, waiting, done

        public var word: String {
            switch self {
            case .stopped: "Stopped"
            case .needs: "Needs you"
            case .waiting: "Waiting"
            case .done: "Done"
            }
        }

        public var color: SwiftUI.Color {
            switch self {
            case .stopped: Cockpit.Color.warning
            case .needs: Cockpit.Color.caution
            case .waiting: Cockpit.Color.textTertiary
            case .done: Cockpit.Color.engaged
            }
        }
    }
}

public struct SeverityMark: View {
    let severity: Cockpit.Severity
    let size: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var turned = false

    public init(_ severity: Cockpit.Severity, size: CGFloat) {
        self.severity = severity
        self.size = size
    }

    public var body: some View {
        MarkGlyph(severity, size: size, ink: severity.color)
            .rotationEffect(.degrees(severity == .waiting && turned ? 360 : 0))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
            .onAppear {
                guard severity == .waiting, !reduceMotion else { return }
                withAnimation(.linear(duration: 1).repeatForever(autoreverses: false)) { turned = true }
            }
    }
}

struct MarkGlyph: View {
    let severity: Cockpit.Severity
    let size: CGFloat
    let ink: Color

    init(_ severity: Cockpit.Severity, size: CGFloat, ink: Color) {
        self.severity = severity
        self.size = size
        self.ink = ink
    }

    var body: some View {
        let unit = size / 24
        let ring = max(2 * unit, 1.25)
        let bar = max(2.2 * unit, 1.35)
        Canvas { context, _ in
            func at(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * unit, y: y * unit) }
            func dot(_ x: CGFloat, _ y: CGFloat, _ r: CGFloat) {
                let r = max(r * unit, bar * 0.62)
                context.fill(Path(ellipseIn: CGRect(x: x * unit - r, y: y * unit - r, width: 2 * r, height: 2 * r)), with: .color(ink))
            }
            let round = StrokeStyle(lineWidth: bar, lineCap: .round, lineJoin: .round)
            switch severity {
            case .stopped, .done:
                let r = 9.2 * unit
                context.stroke(Path(ellipseIn: CGRect(x: 12 * unit - r, y: 12 * unit - r, width: 2 * r, height: 2 * r)), with: .color(ink),
                               lineWidth: ring)
                if severity == .stopped {
                    var stem = Path()
                    stem.move(to: at(12, 7.2))
                    stem.addLine(to: at(12, 12.8))
                    context.stroke(stem, with: .color(ink), style: round)
                    dot(12, 16.6, 1.35)
                } else {
                    var check = Path()
                    check.move(to: at(7.8, 12.4))
                    check.addLine(to: at(10.7, 15.3))
                    check.addLine(to: at(16.3, 9.3))
                    context.stroke(check, with: .color(ink), style: round)
                }
            case .needs:
                var triangle = Path()
                triangle.move(to: at(12, 3.6))
                triangle.addLine(to: at(21.4, 20))
                triangle.addLine(to: at(2.6, 20))
                triangle.closeSubpath()
                context.stroke(triangle, with: .color(ink), style: StrokeStyle(lineWidth: ring, lineJoin: .round))
                var stem = Path()
                stem.move(to: at(12, 9.4))
                stem.addLine(to: at(12, 14))
                context.stroke(stem, with: .color(ink), style: round)
                dot(12, 17, 1.3)
            case .waiting:
                let r = 8.6 * unit
                let circle = Path(ellipseIn: CGRect(x: 12 * unit - r, y: 12 * unit - r, width: 2 * r, height: 2 * r))
                context.stroke(circle, with: .color(ink.opacity(0.35)), lineWidth: bar)
                var arc = Path()
                arc.addArc(center: at(12, 12), radius: r, startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false)
                context.stroke(arc, with: .color(ink), style: round)
            }
        }
        .frame(width: size, height: size)
    }
}

public struct Signal: View {
    let kind: Cockpit.SignalKind
    let word: String
    let detail: String?
    let strong: Bool
    let pulse: Bool
    @Environment(\.cockpitPlatform) private var platform

    public init(_ kind: Cockpit.SignalKind, _ word: String, detail: String? = nil, strong: Bool = false, pulse: Bool = false) {
        self.kind = kind
        self.word = word
        self.detail = detail
        self.strong = strong
        self.pulse = pulse
    }

    public var body: some View {
        HStack(spacing: 6) {
            SignalShape(kind, size: platform == .ios ? 12 : 10, pulse: pulse)
            Text(word)
                .cockpit(strong ? .rowTitle : .footnote)
                .foregroundStyle(kind.wordColor)
            if let detail {
                Text("· \(detail)")
                    .cockpit(.footnote)
                    .foregroundStyle(Cockpit.Color.textTertiary)
            }
        }
        .lineLimit(1)
        .accessibilityElement(children: .combine)
    }
}
