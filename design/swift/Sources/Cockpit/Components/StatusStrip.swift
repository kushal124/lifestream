import SwiftUI

public struct StatusStrip: View {
    public struct Act {
        let label: String
        let busy: Bool
        let perform: () -> Void

        public init(_ label: String, busy: Bool = false, perform: @escaping () -> Void) {
            self.label = label
            self.busy = busy
            self.perform = perform
        }
    }

    public enum Ground: Sendable {
        case banner, stopped, advice
    }

    public struct Fold {
        let more: Int
        let identifier: String?
        let open: () -> Void

        public init(more: Int, identifier: String? = nil, open: @escaping () -> Void) {
            self.more = more
            self.identifier = identifier
            self.open = open
        }
    }

    public struct Others {
        let count: Int
        let show: () -> Void

        public init(_ count: Int, show: @escaping () -> Void) {
            self.count = count
            self.show = show
        }
    }

    public static let dismissWord = "Dismiss"

    let severity: Cockpit.Severity
    let title: String
    let line: String?
    let since: String?
    let act: Act?
    let details: (() -> Void)?
    let dismiss: (() -> Void)?
    let fold: Fold?
    let others: Others?
    let ground: Ground
    let identifier: String?
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .subheadline) private var titleMiddle: CGFloat = 5.3
    @State private var dragged: CGFloat = 0
    @State private var leaving = false

    public init(_ severity: Cockpit.Severity, title: String, line: String? = nil, since: String? = nil, act: Act? = nil,
                details: (() -> Void)? = nil, dismiss: (() -> Void)? = nil, fold: Fold? = nil, others: Others? = nil,
                ground: Ground = .banner, identifier: String? = nil) {
        self.identifier = identifier
        self.severity = severity
        self.title = title
        self.line = line
        self.since = since
        self.act = act
        self.details = details
        self.dismiss = dismiss
        self.fold = fold
        self.others = others
        self.ground = ground
    }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: platform == .ios ? Cockpit.Space.s4 : Cockpit.Radius.lg, style: .continuous)
        Group {
            if platform == .ios, ground != .banner {
                stacked
            } else {
                row
            }
        }
        .background(shape.fill(fill))
        .overlay(shape.strokeBorder(stroke, lineWidth: Cockpit.Stroke.border))
        .contentShape(shape)
        .onTapGesture { tapped?() }
        .accessibilityElement(children: .contain)
        .offset(x: dragged)
        .opacity(leaving ? 0 : 1 - min(0.6, abs(dragged) / 400))
        .modifier(SwipeAway(on: platform == .ios && dismiss != nil, moved: { dragged = $0 }, ended: swiped))
    }

    private var tapped: (() -> Void)? { fold?.open ?? details }

    private var fill: Color {
        switch ground {
        case .banner: Cockpit.Color.alertGround
        case .stopped: Cockpit.Color.warningSoft
        case .advice: platform == .ios ? Cockpit.Color.surface : Cockpit.Color.canvas
        }
    }

    private var stroke: Color {
        ground == .stopped ? Cockpit.Color.warning.opacity(0.22) : Cockpit.Color.hairline
    }

    private func swiped(across: CGFloat, projected: CGFloat) {
        let gone = abs(across) > 110 || abs(projected) > 260
        guard gone, let dismiss else {
            withAnimation(Cockpit.Ease.out(Cockpit.Duration.base)) { dragged = 0 }
            return
        }
        withAnimation(reduceMotion ? .easeOut(duration: Cockpit.Duration.fast) : Cockpit.Ease.out(Cockpit.Duration.base)) {
            dragged = across < 0 ? -600 : 600
            leaving = true
        } completion: {
            dismiss()
            dragged = 0
            leaving = false
        }
    }

    private var row: some View {
        let ios = platform == .ios
        return HStack(alignment: .center, spacing: ios ? Cockpit.Space.s3 : 9) {
            HStack(alignment: .stripTitle, spacing: ios ? Cockpit.Space.s3 : 9) {
                mark
                words
            }
            .accessibilityElement(children: .ignore)
            .modifier(StripSpoken(strip: self))
            if let others, others.count > 0 {
                Button(action: others.show) {
                    Text("+\(others.count)")
                        .cockpit(ios ? .footnote : .caption)
                        .fontWeight(.medium)
                        .monospacedDigit()
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .padding(.horizontal, Cockpit.Space.s2)
                        .frame(minHeight: ios ? 26 : 20)
                        .background(Capsule().fill(Cockpit.Color.text.opacity(0.06)))
                        .contentShape(Rectangle().inset(by: -8))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(others.count) more")
                .accessibilityIdentifier(identifier.map { $0 + ".others" } ?? "")
            }
            if let act { button(act) }
            if act == nil, others == nil, dismiss == nil, details != nil {
                Icon(.forward, size: .sm)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .accessibilityHidden(true)
            }
            if let dismiss { cross(dismiss) }
        }
        .padding(.leading, ios ? 14 : 10)
        .padding(.trailing, act != nil || dismiss != nil ? Cockpit.Space.s2 : ios ? 14 : 10)
        .padding(.vertical, ios ? 10 : 9)
        .frame(minHeight: ios ? 56 : 40)
    }

    private var stacked: some View {
        let lined = said != nil
        return HStack(alignment: .stripTitle, spacing: Cockpit.Space.s3) {
            mark
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .stripTitle, spacing: Cockpit.Space.s2) {
                    VStack(alignment: .leading, spacing: 2) {
                        titled
                        if act == nil { saidText }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .ignore)
                    .modifier(StripSpoken(strip: self))
                    if let act, !lined { button(act) }
                    if let dismiss { cross(dismiss).padding(.trailing, -Cockpit.Space.s1) }
                }
                if let act, lined { actRow(act) }
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 14)
        .padding(.vertical, Cockpit.Space.s3)
        .frame(minHeight: 56)
        .environment(\.cockpitButtonHeight, Self.phoneButton)
    }

    private static let phoneButton: CGFloat = 28

    private func actRow(_ act: Act) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s3) {
                saidText.lineLimit(1).fixedSize(horizontal: true, vertical: false)
                Spacer(minLength: 0)
                button(act)
            }
            .padding(.top, 2)
            VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                saidText
                button(act).frame(maxWidth: .infinity, alignment: .trailing)
            }
            .padding(.top, 2)
        }
    }

    private var mark: some View {
        SeverityMark(severity, size: platform == .ios ? 18 : 14)
            .alignmentGuide(.stripTitle) { $0[VerticalAlignment.center] }
    }

    private var titled: some View {
        Text(title)
            .cockpit(platform == .ios ? Cockpit.Role.subhead : .rowTitle)
            .fontWeight(.semibold)
            .foregroundStyle(Cockpit.Color.text)
            .lineLimit(platform == .ios ? 2 : nil)
            .fixedSize(horizontal: false, vertical: true)
            .alignmentGuide(.stripTitle) { $0[.firstTextBaseline] - titleMiddle }
    }

    private var words: some View {
        VStack(alignment: .leading, spacing: platform == .ios ? 1 : 0) {
            titled
            saidText
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var saidText: some View {
        if let said {
            said.cockpit(platform == .ios ? .footnote : .caption)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func button(_ act: Act) -> some View {
        Button(act.label, action: act.perform)
            .buttonStyle(.cockpit(.secondary, size: .small, busy: act.busy))
            .accessibilityIdentifier(identifier.map { $0 + ".act" } ?? "")
    }

    private func cross(_ dismiss: @escaping () -> Void) -> some View {
        Button(action: dismiss) {
            Icon(.close, size: .sm)
                .foregroundStyle(Cockpit.Color.textTertiary)
                .frame(width: 22, height: 22)
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle().inset(by: -11))
        .alignmentGuide(.stripTitle) { $0[VerticalAlignment.center] }
        .accessibilityLabel(Self.dismissWord)
        .help(Self.dismissWord + " · comes back if it gets worse")
        .accessibilityIdentifier(identifier.map { $0 + ".dismiss" } ?? "")
    }

    private var said: Text? {
        let secondary = Cockpit.Color.textSecondary
        var parts: [Text] = []
        if let line { parts.append(Text(line).foregroundStyle(secondary)) }
        if let since { parts.append(Text(since).foregroundStyle(Cockpit.Color.textTertiary)) }
        if let fold, fold.more > 0 {
            let count = Text("\(fold.more) more ").fontWeight(.medium).foregroundStyle(secondary)
            let chevron = Text(Image(systemName: "chevron.down")).font(.system(size: platform == .ios ? 10 : 9, weight: .semibold))
                .foregroundStyle(Cockpit.Color.textTertiary)
            parts.append(Text("\(count)\(chevron)"))
        }
        guard let first = parts.first else { return nil }
        let dot = Text(" · ").foregroundStyle(Cockpit.Color.textTertiary)
        return parts.dropFirst().reduce(first) { said, part in Text("\(said)\(dot)\(part)") }
    }

    fileprivate var spoken: String {
        let more = fold.map { "\($0.more) more" }
        return [severity.word, title, line, since, more].compactMap { $0 }.joined(separator: ". ")
    }

    fileprivate var actions: (open: (() -> Void)?, dismiss: (() -> Void)?) { (tapped, dismiss) }
}

private struct StripSpoken: ViewModifier {
    let strip: StatusStrip

    func body(content: Content) -> some View {
        let actions = strip.actions
        content
            .accessibilityLabel(strip.spoken)
            .accessibilityValue(strip.act?.label ?? "")
            .accessibilityAddTraits(actions.open != nil ? .isButton : [])
            .accessibilityAction { actions.open?() }
            .accessibilityActions {
                if let dismiss = actions.dismiss {
                    Button(StatusStrip.dismissWord, action: dismiss)
                }
            }
            .accessibilityIdentifier(strip.fold?.identifier ?? strip.identifier ?? "")
    }
}

public struct StatusStack<Item: Identifiable, Strip: View>: View {
    let items: [Item]
    @Binding var open: Bool
    let lessWord: String
    let identifier: String?
    let strip: (Item, StatusStrip.Fold?) -> Strip
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(_ items: [Item], open: Binding<Bool>, less: String = "Show less", identifier: String? = nil,
                @ViewBuilder strip: @escaping (Item, StatusStrip.Fold?) -> Strip) {
        self.items = items
        self._open = open
        self.lessWord = less
        self.identifier = identifier
        self.strip = strip
    }

    public var body: some View {
        let ios = platform == .ios
        let folded = !open && items.count > 1
        VStack(alignment: .trailing, spacing: ios ? Cockpit.Space.s2 : 6) {
            if folded, let first = items.first {
                strip(first, StatusStrip.Fold(more: items.count - 1, identifier: identifier.map { $0 + ".more" }) { toggle(true) })
                    .padding(.bottom, slivers.reduce(0) { $0 + $1.peek })
                    .background(alignment: .bottom) { stack }
                    .zIndex(1)
            } else {
                ForEach(items) { item in strip(item, nil) }
                if items.count > 1 {
                    Button { toggle(false) } label: {
                        HStack(spacing: 4) {
                            Text(lessWord)
                            Icon(.collapse, size: .sm)
                        }
                        .cockpit(ios ? .footnote : .caption)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .padding(.vertical, ios ? Cockpit.Space.s1 : 2)
                        .padding(.trailing, ios ? Cockpit.Space.s2 : 6)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(identifier.map { $0 + ".less" } ?? "")
                }
            }
        }
    }

    private func toggle(_ to: Bool) {
        withAnimation(reduceMotion ? .easeInOut(duration: Cockpit.Duration.fast) : Cockpit.Ease.out(Cockpit.Duration.base)) { open = to }
    }

    private var slivers: [(inset: CGFloat, peek: CGFloat)] {
        platform == .ios ? [(10, 6), (22, 6)] : [(8, 5), (18, 5)]
    }

    private var stack: some View {
        let radius: CGFloat = platform == .ios ? Cockpit.Space.s4 : Cockpit.Radius.lg
        let slivers = self.slivers
        return VStack(spacing: 0) {
            ForEach(Array(slivers.enumerated()), id: \.offset) { index, sliver in
                Sliver(radius: radius, peek: sliver.peek)
                    .padding(.horizontal, sliver.inset)
                    .opacity(index == 0 ? 1 : 0.6)
            }
        }
        .accessibilityHidden(true)
    }
}

private struct SwipeAway: ViewModifier {
    let on: Bool
    let moved: (CGFloat) -> Void
    let ended: (_ across: CGFloat, _ projected: CGFloat) -> Void

    func body(content: Content) -> some View {
        #if os(iOS)
        if on {
            content.gesture(SidewaysPan(moved: moved, ended: ended))
        } else {
            content
        }
        #else
        content
        #endif
    }
}

#if os(iOS)
private struct SidewaysPan: UIGestureRecognizerRepresentable {
    let moved: (CGFloat) -> Void
    let ended: (_ across: CGFloat, _ projected: CGFloat) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.maximumNumberOfTouches = 1
        pan.delegate = context.coordinator
        return pan
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        let across = recognizer.translation(in: recognizer.view).x
        switch recognizer.state {
        case .began, .changed: moved(across)
        case .ended: ended(across, across + Self.glide(recognizer.velocity(in: recognizer.view).x))
        case .cancelled, .failed: ended(0, 0)
        default: break
        }
    }

    static func glide(_ velocity: CGFloat) -> CGFloat {
        let rate = UIScrollView.DecelerationRate.normal.rawValue
        return velocity / 1000 * rate / (1 - rate)
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

private struct Sliver: View {
    let radius: CGFloat
    let peek: CGFloat
    @Environment(\.cockpitPlatform) private var platform

    var body: some View {
        let shape = UnevenRoundedRectangle(cornerRadii: .init(bottomLeading: radius, bottomTrailing: radius), style: .continuous)
        let ground = platform == .ios ? Cockpit.Color.surface : Cockpit.Color.canvas
        ZStack {
            shape.fill(ground)
            shape.fill(Cockpit.Color.text.opacity(0.05))
            shape.strokeBorder(Cockpit.Color.hairline, lineWidth: Cockpit.Stroke.border)
        }
        .frame(height: radius + peek)
        .frame(height: peek, alignment: .bottom)
        .clipped()
    }
}

extension VerticalAlignment {
    private enum StripTitle: AlignmentID {
        static func defaultValue(in context: ViewDimensions) -> CGFloat { context[VerticalAlignment.center] }
    }

    static let stripTitle = VerticalAlignment(StripTitle.self)
}
