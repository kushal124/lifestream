import SwiftUI

public struct Loading: View {
    public enum Size: Sendable {
        case page
        case inline
        case glyph
    }

    let label: String
    let size: Size
    let words: String?
    var forced: Double?
    var forcedWaiting = false
    @State private var shown = false
    @State private var waiting = false
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.skeletonForced) private var held
    @Environment(\.reachLacks) private var lacks

    private var heldAt: Double? { forced ?? held }

    public init(_ label: String = "Loading", size: Size = .page, words: String? = nil) {
        self.label = label
        self.size = size
        self.words = words
    }

    public var body: some View {
        if !lacks { drawn }
    }

    private var drawn: some View {
        Group {
            switch size {
            case .page:
                VStack(spacing: Cockpit.Space.s3) {
                    mark(Cockpit.Size.loading)
                    Text(words ?? "Waiting for Lifestream.")
                        .cockpit(.body)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .opacity(waiting || forcedWaiting ? 1 : 0)
                }
                .padding(.vertical, Cockpit.Space.s16)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .inline:
                mark(Cockpit.Size.iconSm)
                    .frame(maxWidth: .infinity, minHeight: platform == .ios ? Cockpit.Size.row : Cockpit.Size.rowMac)
            case .glyph:
                mark(Cockpit.Size.iconSm)
            }
        }
        .opacity(shown || heldAt != nil ? 1 : 0)
        .task {
            guard heldAt == nil else { return }
            do {
                try await Task.sleep(for: .seconds(Cockpit.Duration.grace))
                withAnimation(.easeOut(duration: Cockpit.Duration.fast)) { shown = true }
                try await Task.sleep(for: .seconds(Cockpit.Duration.patience - Cockpit.Duration.grace))
                withAnimation(.easeOut(duration: Cockpit.Duration.fast)) { waiting = true }
            } catch {
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityAddTraits(.updatesFrequently)
    }

    private func mark(_ side: CGFloat) -> some View {
        TimelineView(.animation(paused: !shown || heldAt != nil)) { context in
            let seconds = context.date.timeIntervalSinceReferenceDate
            let still = reduceMotion && heldAt == nil
            let moment = heldAt ?? seconds.truncatingRemainder(dividingBy: Cockpit.Duration.breath) / Cockpit.Duration.breath
            let breath = still ? 0.7 + 0.3 * cos(2 * .pi * seconds / Cockpit.Duration.breath) : 1
            Streams(points: still ? LoadingMark.still : LoadingMark.at(moment))
                .fill(Cockpit.Color.textSecondary)
                .clipShape(RoundedRectangle(cornerRadius: side * LoadingMark.tileRadius, style: .continuous))
                .opacity(breath)
                .frame(width: side, height: side)
        }
        .accessibilityHidden(true)
    }
}

struct Streams: Shape {
    let points: [Double]

    func path(in rect: CGRect) -> Path {
        let bank = 1 + 3 * LoadingMark.segments
        let point = { (i: Int) in CGPoint(x: rect.minX + points[2 * i] * rect.width, y: rect.minY + points[2 * i + 1] * rect.height) }
        var path = Path()
        for stream in stride(from: 0, to: points.count / 2, by: 2 * bank) {
            path.move(to: point(stream))
            for first in [stream, stream + bank] {
                if first != stream { path.addLine(to: point(first)) }
                for i in stride(from: first + 1, to: first + bank, by: 3) {
                    path.addCurve(to: point(i + 2), control1: point(i), control2: point(i + 1))
                }
            }
            path.closeSubpath()
        }
        return path
    }
}

private extension LoadingMark {
    static func at(_ moment: Double) -> [Double] {
        let x = moment * Double(frames.count)
        let i = Int(x) % frames.count, f = x - x.rounded(.down)
        return zip(frames[i], frames[(i + 1) % frames.count]).map { $0 + ($1 - $0) * f }
    }
}
