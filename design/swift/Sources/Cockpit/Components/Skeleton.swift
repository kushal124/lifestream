import SwiftUI

public extension View {
    func reading(_ active: Bool) -> some View {
        modifier(Reading(active: active))
    }
}

struct Reading: ViewModifier {
    let active: Bool
    @State private var shownAt: Date?
    @State private var settled = false
    @Environment(\.skeletonForced) private var forced
    @Environment(\.reachLacks) private var lacks
    @Environment(\.redactionReasons) private var redaction
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.self) private var environment

    func body(content: Content) -> some View {
        let active = active && !redaction.skeleton
        let runs = active && !lacks && forced == nil && shownAt != nil && !(settled && reduceMotion)
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !runs)) { context in
            if active {
                content
                    .redacted(reason: .placeholder)
                    .environment(\.skeletonTone, tone(at: context.date))
                    .opacity(lacks ? 0 : 1)
                    .accessibilityHidden(true)
            } else {
                content
            }
        }
        .animation(.easeOut(duration: Cockpit.Duration.fast), value: active)
        .waiting(active && forced == nil)
        .allowsHitTesting(!active)
        .overlay {
            if active {
                Color.clear
                    .accessibilityElement()
                    .accessibilityLabel("Loading")
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
        .task(id: Phase(active: active, held: forced != nil)) {
            guard active else {
                shownAt = nil
                settled = false
                return
            }
            if forced != nil || settled {
                shownAt = shownAt ?? .now
                settled = true
                return
            }
            shownAt = nil
            try? await Task.sleep(for: .seconds(Cockpit.Duration.grace))
            guard !Task.isCancelled else { return }
            shownAt = .now
            try? await Task.sleep(for: .seconds(Cockpit.Duration.fast))
            if !Task.isCancelled { settled = true }
        }
    }

    private struct Phase: Hashable {
        let active: Bool
        let held: Bool
    }

    private func tone(at date: Date) -> Color {
        let shown: Double
        if forced != nil || settled {
            shown = 1
        } else if let shownAt {
            let t = min(1, max(0, date.timeIntervalSince(shownAt) / Cockpit.Duration.fast))
            shown = 1 - (1 - t) * (1 - t)
        } else {
            shown = 0
        }
        let moment = forced ?? (reduceMotion ? 0 : Self.breath(at: date))
        return Self.tone(moment, shown: shown, in: environment)
    }

    static func breath(at date: Date) -> Double {
        let x = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2 * Cockpit.Duration.breath) / Cockpit.Duration.breath
        return 0.5 - 0.5 * cos(.pi * (x <= 1 ? x : 2 - x))
    }

    static func tone(_ moment: Double, shown: Double, in environment: EnvironmentValues) -> Color {
        let from = Cockpit.Color.selection.resolve(in: environment)
        let to = Cockpit.Color.hover.resolve(in: environment)
        let f = Float(moment)
        func mix(_ a: Float, _ b: Float) -> Float { a + (b - a) * f }
        return Color(Color.Resolved(red: mix(from.red, to.red), green: mix(from.green, to.green), blue: mix(from.blue, to.blue),
                                    opacity: mix(from.opacity, to.opacity) * Float(shown)))
    }
}

struct SkeletonText: View {
    let style: Cockpit.TextStyle
    @Environment(\.skeletonTone) private var tone
    @Environment(\.dynamicTypeSize) private var typeSize

    private var size: CGFloat { style.textStyle.map { Cockpit.scaled(style.size, relativeTo: $0, at: typeSize) } ?? style.size }

    var body: some View {
        GeometryReader { proxy in
            let spacing = max(0, style.lineHeight - style.size * 1.2)
            let lines = max(1, Int(((proxy.size.height + spacing) / (size * 1.2 + spacing)).rounded()))
            let line = (proxy.size.height - CGFloat(lines - 1) * spacing) / CGFloat(lines)
            let bar = size * 0.55
            ForEach(0..<lines, id: \.self) { index in
                Capsule()
                    .fill(tone)
                    .frame(width: proxy.size.width * (lines > 1 && index == lines - 1 ? 0.6 : 1), height: bar)
                    .offset(y: CGFloat(index) * (line + spacing) + (line - bar) / 2)
            }
        }
        .accessibilityHidden(true)
    }
}

struct SkeletonIcon: View {
    let side: CGFloat
    @Environment(\.skeletonTone) private var tone

    var body: some View {
        let square = min(Cockpit.Size.iconSm, side)
        RoundedRectangle(cornerRadius: 5, style: .continuous)
            .fill(tone)
            .frame(width: square, height: square)
            .frame(width: side, height: side)
    }
}

extension View {
    @ViewBuilder func unredacted(when known: Bool) -> some View {
        if known { unredacted() } else { self }
    }
}

extension EnvironmentValues {
    @Entry var skeletonTone: Color = Cockpit.Color.selection
    @Entry public var skeletonForced: Double?
}

extension RedactionReasons {
    var skeleton: Bool { contains(.placeholder) }
}
