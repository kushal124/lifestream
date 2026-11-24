import SwiftUI
#if os(iOS)
import UIKit
#endif

public struct WeekFigure: View {
    public struct Bar: Sendable {
        let value: Double
        let amount: String
        let noun: String?
        let when: String

        public init(_ value: Double, amount: String, noun: String? = nil, when: String) {
            self.value = value
            self.amount = amount
            self.noun = noun
            self.when = when
        }

        public init(count: Int, noun: String? = nil, when: String) {
            self.init(Double(count), amount: WeekFigure.number(count), noun: noun, when: when)
        }

        var words: String { [noun, when].compactMap { $0 }.joined(separator: " · ") }
        var spoken: String { "\(when), " + [amount, noun].compactMap { $0 }.joined(separator: " ") }
    }

    let amount: String
    let words: String
    let line: String?
    let foot: String?
    let bars: [Bar]
    let ends: (String, String)?
    let labels: [String]?
    let open: ((Int) -> Void)?
    let bare: Bool
    let marked: Mark

    public enum Mark: Equatable, Sendable {
        case last
        case bar(Int)
        case none

        public static func busiest(_ counts: [Int]) -> Mark {
            guard let most = counts.max(), most > 0, counts.filter({ $0 == most }).count == 1,
                  let index = counts.firstIndex(of: most) else { return .none }
            return .bar(index)
        }
    }
    var lit: Int?
    @State private var read: Int?
    @State private var spoken: Int?
    @State private var scrubbing = false
    @State private var resting: Task<Void, Never>?
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.redactionReasons) private var redaction
    @Environment(\.skeletonTone) private var tone

    public init(_ amount: String, words: String, line: String? = nil, bars: [Bar], ends: (String, String)? = nil,
                labels: [String]? = nil, bare: Bool = false, marked: Mark = .last, foot: String? = nil, open: ((Int) -> Void)? = nil) {
        self.amount = amount
        self.words = words
        self.line = line
        self.foot = foot
        self.bars = bars
        self.ends = ends
        self.labels = labels
        self.bare = bare
        self.open = open
        self.marked = marked
    }

    static let least: CGFloat = 3
    static let linger: Duration = .seconds(2.5)
    static let tappable = 14

    static func top(_ values: [Double]) -> Double {
        let sorted = values.map { max(0, $0) }.sorted(by: >)
        let most = sorted.first ?? 0
        let next = sorted.count > 1 ? sorted[1] : 0
        return next > 0 && most > 4 * next ? 1.25 * next : most
    }

    nonisolated static func number(_ count: Int) -> String {
        count.formatted(.number.grouping(.automatic).locale(Locale(identifier: "en_US")))
    }

    private var shown: Int? { lit ?? read }
    private var height: CGFloat { platform == .ios ? Cockpit.Space.s10 : Cockpit.Space.s12 }
    private var gap: CGFloat { bars.count <= Self.tappable ? Cockpit.Space.s1 : bars.count <= 60 ? 2 : 1 }

    public var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
            if !bare { readout }
            if let line {
                Text(line)
                    .cockpit(.subhead)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .cockpitLines(1)
                    .unredacted()
            }
            if !bars.isEmpty {
                chart
                    .padding(.top, bare ? 0 : Cockpit.Space.s3)
                    .overlay(alignment: .topLeading) { if bare { said } }
                if let labels, labels.count == bars.count {
                    HStack(spacing: gap) {
                        ForEach(labels.indices, id: \.self) { index in
                            Text(labels[index])
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .cockpit(.monoTime)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .unredacted()
                    .accessibilityHidden(true)
                } else if let ends {
                    HStack {
                        Text(ends.0)
                        Spacer(minLength: Cockpit.Space.s2)
                        Text(ends.1)
                    }
                    .cockpit(.monoTime)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .cockpitLines(1)
                    .unredacted()
                }
            }
            if let foot {
                Text(foot)
                    .cockpit(.subhead)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .cockpitLines(2)
                    .padding(.top, Cockpit.Space.s3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([amount + " " + words, line, foot].compactMap { $0 }.joined(separator: ", "))
        .accessibilityValue(bars.isEmpty ? "" : bars[spoken ?? bars.count - 1].spoken)
        .accessibilityAdjustableAction { direction in
            guard !bars.isEmpty else { return }
            let at = spoken ?? bars.count - 1
            switch direction {
            case .increment: spoken = min(bars.count - 1, at + 1)
            case .decrement: spoken = max(0, at - 1)
            @unknown default: break
            }
        }
        .modifier(OpenAction(open: bars.isEmpty ? nil : open) { spoken ?? bars.count - 1 })
        .onDisappear { resting?.cancel() }
    }

    @ViewBuilder private var said: some View {
        if let shown, bars.indices.contains(shown) {
            Text(bars[shown].amount + " " + bars[shown].words)
                .cockpit(.subhead)
                .foregroundStyle(Cockpit.Color.text)
                .lineLimit(1)
                .padding(.horizontal, Cockpit.Space.s3)
                .padding(.vertical, Cockpit.Space.s1)
                .background(Capsule().fill(Cockpit.Color.raised))
                .allowsHitTesting(false)
        }
    }

    @ViewBuilder private var readout: some View {
        if let shown, bars.indices.contains(shown) {
            let bar = bars[shown]
            if let open {
                Button {
                    resting?.cancel()
                    read = nil
                    open(shown)
                } label: {
                    reading(bar.amount, bar.words, chevron: true)
                }
                .buttonStyle(.plain)
            } else {
                reading(bar.amount, bar.words, chevron: false)
            }
        } else {
            reading(amount, words, chevron: false)
        }
    }

    private func reading(_ amount: String, _ words: String, chevron: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s2) {
            Text(amount)
                .cockpit(platform == .ios ? Cockpit.Style.iosTitle1 : platform.style(.figureXL))
                .monospacedDigit()
                .foregroundStyle(Cockpit.Color.text)
                .fixedSize()
            Text(words)
                .cockpit(platform == .ios ? .subhead : .body)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .cockpitLines(2)
                .fixedSize(horizontal: false, vertical: true)
            if chevron {
                Icon(.forward, size: .xs)
                    .foregroundStyle(Cockpit.Color.textTertiary)
            }
        }
        .contentShape(Rectangle())
    }

    private var chart: some View {
        let top = Self.top(bars.map(\.value))
        return VStack(spacing: Cockpit.Space.s1) {
            if bare, platform == .ios, bars.count <= 7, !redaction.skeleton,
               let tallest = bars.indices.max(by: { bars[$0].value < bars[$1].value }), bars[tallest].value > 0 {
                HStack(spacing: gap) {
                    ForEach(bars.indices, id: \.self) { index in
                        Text(index == tallest ? bars[index].amount : " ")
                            .cockpit(.footnote)
                            .foregroundStyle(Cockpit.Color.textSecondary)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity)
                    }
                }
                .accessibilityHidden(true)
            }
            HStack(alignment: .bottom, spacing: gap) {
                ForEach(bars.indices, id: \.self) { index in
                    bar(index, top: top)
                }
            }
            .frame(height: height)
            if platform == .ios, bare, bars.count <= 7, !redaction.skeleton {
                HStack(spacing: gap) {
                    ForEach(bars.indices, id: \.self) { index in
                        Text(String(bars[index].when.prefix(1)))
                            .cockpit(.caption2)
                            .foregroundStyle(index == bars.count - 1 ? Cockpit.Color.text : Cockpit.Color.textTertiary)
                            .frame(maxWidth: .infinity)
                    }
                }
                .accessibilityHidden(true)
            }
        }
        .overlay {
            GeometryReader { proxy in
                #if os(iOS)
                Color.clear
                    .contentShape(Rectangle())
                    .gesture(BarsScrub { x in
                        scrubbing = true
                        resting?.cancel()
                        read = index(at: x, width: proxy.size.width)
                    } ended: {
                        scrubbing = false
                        linger()
                    })
                    .onTapGesture(coordinateSpace: .local) { point in
                        guard bars.count <= Self.tappable else { return }
                        read = index(at: point.x, width: proxy.size.width)
                        linger()
                    }
                #else
                Color.clear
                    .contentShape(Rectangle())
                    .simultaneousGesture(touch(width: proxy.size.width))
                #endif
            }
        }
    }

    @ViewBuilder private func bar(_ index: Int, top: Double) -> some View {
        if redaction.skeleton {
            BarShape()
                .fill(tone)
                .frame(height: height * Self.low)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        } else {
            drawn(index, top: top)
        }
    }

    static let low: CGFloat = 0.28

    private func drawn(_ index: Int, top: Double) -> some View {
        let value = bars[index].value
        let phone = platform == .ios
        let tall = value > 0 && top > 0 ? max(Self.least, height * min(1, value / top)) : phone ? 4 : Cockpit.Stroke.line
        let here = marked == .bar(index) || (marked == .last && index == bars.count - 1)
        let ink = value <= 0 ? (phone ? Cockpit.Color.textTertiary : Cockpit.Color.data4)
            : here ? Cockpit.Color.here
            : index == shown ? Cockpit.Color.textSecondary : Cockpit.Color.data3
        return BarShape()
            .fill(ink)
            .frame(maxWidth: phone ? (value <= 0 ? 4 : Self.bar) : .infinity)
            .frame(height: tall)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
    }

    private static var bar: CGFloat { Cockpit.Space.s5 }

    private func touch(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { drag in
                let across = abs(drag.translation.width), down = abs(drag.translation.height)
                if !scrubbing {
                    if down > 6, down > across { read = nil; return }
                    if bars.count > Self.tappable, across <= 6 || across < down { return }
                    scrubbing = true
                }
                resting?.cancel()
                read = index(at: drag.location.x, width: width)
            }
            .onEnded { drag in
                let moved = max(abs(drag.translation.width), abs(drag.translation.height))
                if !scrubbing, bars.count <= Self.tappable, moved <= 6 { read = index(at: drag.location.x, width: width) }
                scrubbing = false
                linger()
            }
    }

    private func linger() {
        guard read != nil else { return }
        resting?.cancel()
        resting = Task { @MainActor in
            try? await Task.sleep(for: Self.linger)
            if !Task.isCancelled { read = nil }
        }
    }

    private func index(at x: CGFloat, width: CGFloat) -> Int {
        guard width > 0, !bars.isEmpty else { return 0 }
        return min(bars.count - 1, max(0, Int(x / width * CGFloat(bars.count))))
    }
}

private struct OpenAction: ViewModifier {
    let open: ((Int) -> Void)?
    let index: () -> Int
    func body(content: Content) -> some View {
        if let open {
            content.accessibilityAction(named: Text("Open")) { open(index()) }
        } else {
            content
        }
    }
}

struct BarShape: Shape {
    func path(in rect: CGRect) -> Path {
        Path(roundedRect: rect, cornerRadius: min(Cockpit.Radius.s2xs, rect.width / 4), style: .continuous)
    }
}

#if os(iOS)
private struct BarsScrub: UIGestureRecognizerRepresentable {
    var changed: (CGFloat) -> Void
    var ended: () -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.maximumNumberOfTouches = 1
        pan.delegate = context.coordinator
        return pan
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        switch recognizer.state {
        case .began, .changed: changed(context.converter.localLocation.x)
        case .ended, .cancelled, .failed: ended()
        default: break
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
            let moved = pan.translation(in: pan.view)
            return abs(moved.x) > abs(moved.y)
        }
    }
}
#endif
