import SwiftUI

public extension Cockpit {
    enum Gap {
        public static let inRow = Space.s1
        public static let row = Space.s2
        public static let group = Space.s3
        public static let tabs = Space.s4
        public static let head = Space.s6
        public static let section = Space.s8
        public static let sheet: CGFloat = 28
        public static let list = Space.s4
        public static let edge = Space.s5
    }
}

public struct Drawer<Content: View, Foot: View>: View {
    let title: String
    let facts: String?
    let reading: Bool
    let identifier: String?
    let close: (() -> Void)?
    let edit: SheetEdit?
    let content: Content
    let foot: Foot

    @State private var fixed: CGFloat = 0
    @State private var body_: CGFloat?
    @State private var under = 0.0
    @State private var safeFoot: CGFloat = 0
    @State private var own = SheetActs()

    public init(_ title: String, facts: String? = nil, reading: Bool = false, identifier: String? = nil, close: (() -> Void)? = nil,
                edit: SheetEdit? = nil, @ViewBuilder content: () -> Content, @ViewBuilder foot: () -> Foot) {
        self.title = title
        self.facts = facts
        self.reading = reading
        self.identifier = identifier
        self.close = close
        self.edit = edit
        self.content = content()
        self.foot = foot()
    }

    private var hasFoot: Bool { Foot.self != EmptyView.self }

    private var acts: SheetActs { edit?.acts ?? own }

    private var held: CGFloat? { body_.map { fixed + Cockpit.Space.s3 + $0 } }
    private var overflows: Bool { (held ?? 0) - safeFoot >= Cockpit.sheetHugLimit }

    public var body: some View {
        SheetMargined { margin in framed(margin) }
    }

    private func framed(_ margin: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                DrawerHead(title: title, facts: facts, reading: reading, identifier: identifier, close: close, edit: edit, acts: acts)
                if let edit, acts.outcome.failure != nil { SheetFailure(edit: edit, acts: acts) }
            }
            .padding(.horizontal, margin)
            .padding(.top, Cockpit.Gap.edge)
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { fixed = $0 }
            Color.clear.frame(height: Cockpit.Space.s3)
            ScrollView {
                DrawerBody {
                    SheetStack { content }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .environment(\.cockpitRowsFaces, Cockpit.listFace)
                    if hasFoot { foot }
                }
                .padding(.horizontal, margin)
                .padding(.top, Cockpit.Gap.head - Cockpit.Space.s1 - Cockpit.Space.s3)
                .padding(.bottom, Cockpit.Gap.head)
            }
            .scrollBounceBehavior(.basedOnSize)
            .disabled(edit != nil && acts.running)
            .contentMargins(.bottom, overflows ? safeFoot : 0, for: .scrollContent)
            .modifier(DrawerMeasured(height: $body_, under: $under))
            .overlay(alignment: .top) { ScrollFade.Band(ground: Cockpit.Color.surface, under: under) }
            .ignoresSafeArea(.container, edges: .bottom)
        }
        .onSheetFootChange { safeFoot = $0 }
        .groundColor(Cockpit.Color.surface)
        .cockpitSheet()
        .preference(key: SheetContentHeight.self, value: held)
        .modifier(DrawerEditing(edit: edit, acts: acts))
    }
}

public extension Drawer where Foot == EmptyView {
    init(_ title: String, facts: String? = nil, reading: Bool = false, identifier: String? = nil, close: (() -> Void)? = nil,
         edit: SheetEdit? = nil, @ViewBuilder content: () -> Content) {
        self.init(title, facts: facts, reading: reading, identifier: identifier, close: close, edit: edit, content: content,
                  foot: { EmptyView() })
    }
}

private struct DrawerEditing: ViewModifier {
    let edit: SheetEdit?
    let acts: SheetActs

    func body(content: Content) -> some View {
        if let edit { content.modifier(SheetEditing(edit: edit, acts: acts)) } else { content }
    }
}

private struct DrawerHead: View {
    let title: String
    let facts: String?
    let reading: Bool
    let identifier: String?
    let close: (() -> Void)?
    let edit: SheetEdit?
    let acts: SheetActs
    @Environment(\.dismiss) private var dismiss
    @Environment(\.drawerCloses) private var closes

    private var circled: Bool { edit != nil || closes }

    var body: some View {
        HStack(alignment: .top, spacing: Cockpit.Space.s3) {
            if let edit {
                SheetCancel(edit: edit, acts: acts) { if let cancel = edit.cancel { cancel() } else { dismiss() } }
            } else if circled {
                Color.clear.frame(width: DrawerCircle.side, height: DrawerCircle.side)
            }
            VStack(spacing: Cockpit.Gap.inRow) {
                Text(title)
                    .cockpit(.headline)
                    .foregroundStyle(Cockpit.Color.text)
                    .cockpitLines(1)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, minHeight: circled ? DrawerCircle.side : nil)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier(identifier ?? "")
                    .reading(reading)
                if let facts, !facts.isEmpty {
                    Text(facts)
                        .cockpit(.subhead)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .cockpitLines(1)
                        .multilineTextAlignment(.center)
                        .reading(reading)
                }
            }
            .frame(maxWidth: .infinity)
            if let edit {
                SheetKeep(edit: edit, acts: acts)
            } else if closes {
                DrawerClose { if let close { close() } else { dismiss() } }
            }
        }
    }
}

private struct DrawerBody: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let along = ProposedViewSize(width: proposal.width, height: nil)
        let heights = subviews.map { $0.sizeThatFits(along).height }.filter { $0 > 0 }
        return CGSize(width: proposal.width ?? 0, height: heights.reduce(0, +) + Cockpit.Gap.head * CGFloat(max(0, heights.count - 1)))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let along = ProposedViewSize(width: bounds.width, height: nil)
        var top = bounds.minY
        for subview in subviews {
            let height = subview.sizeThatFits(along).height
            subview.place(at: CGPoint(x: bounds.minX, y: top), anchor: .topLeading, proposal: along)
            if height > 0 { top += height + Cockpit.Gap.head }
        }
    }
}

public struct SheetMargined<Content: View>: View {
    let content: (CGFloat) -> Content
    @State private var inset: CGFloat = 8
    @State private var scale: CGFloat = 1
    @Environment(\.displayScale) private var displayScale

    public init(@ViewBuilder content: @escaping (CGFloat) -> Content) {
        self.content = content
    }

    public var body: some View {
        content((Cockpit.Gap.sheet - inset) / scale)
            .environment(\.cockpitSheetScale, scale)
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame in
                let pixel = 1 / max(displayScale, 1)
                let read = min(16, max(0, frame.minX))
                let taken = abs(read - inset) >= pixel ? read : inset
                let window = frame.minX + frame.maxX
                let next = window > 0 ? 1 - 2 * taken / window : 1
                if taken != inset { inset = taken }
                if abs(next - scale) * window >= pixel { scale = next }
            }
    }
}

public struct DrawerClose: View {
    let action: () -> Void
    var back = false

    public init(back: Bool = false, action: @escaping () -> Void) {
        self.back = back
        self.action = action
    }

    public var body: some View {
        DrawerCircle(back ? .back : .close, label: back ? "Back" : "Close", action: action)
            .accessibilityIdentifier(back ? "drawer.back" : "drawer.close")
    }
}

public struct DrawerCircle: View {
    let icon: Cockpit.Icon
    let label: String
    let filled: Bool
    let busy: Bool
    let action: () -> Void
    static let side: CGFloat = Cockpit.Size.target
    public static let spacing: CGFloat = Cockpit.Space.s2

    public init(_ icon: Cockpit.Icon, label: String, filled: Bool = false, busy: Bool = false, action: @escaping () -> Void) {
        self.icon = icon
        self.label = label
        self.filled = filled
        self.busy = busy
        self.action = action
    }

    public var body: some View {
        Button(action: action) { DrawerCircleFace(icon: icon, filled: filled, busy: busy) }
            .buttonStyle(PressedDim())
            .accessibilityLabel(label)
    }
}

private struct DrawerCircleFace: View {
    let icon: Cockpit.Icon
    let filled: Bool
    let busy: Bool
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        let glyph = Group { if busy { Spinner() } else { Icon(icon, size: .md) } }
            .foregroundStyle(filled ? Cockpit.Color.accentInk : Cockpit.Color.text)
            .frame(width: DrawerCircle.side, height: DrawerCircle.side)
        Group {
            if filled {
                glyph.background(Circle().fill(Cockpit.Color.accentSolid))
            } else {
                glyph.cockpitGlass(in: Circle())
            }
        }
        .opacity(enabled || busy ? 1 : Cockpit.Opacity.disabled)
        .contentShape(Circle())
    }
}

public struct KeyValueRow: View {
    let key: String
    let value: String
    let separator: Bool
    let outward: Bool
    let linked: Bool
    let act: (words: String, said: String, perform: () -> Void)?
    let action: (() -> Void)?
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.cockpitKeyColumn) private var column
    @Environment(\.cockpitKeyStacked) private var stacked

    public init(_ key: String, _ value: String, separator: Bool = true, outward: Bool = false, linked: Bool = false,
                act: (words: String, said: String, perform: () -> Void)? = nil, action: (() -> Void)? = nil) {
        self.key = key
        self.value = value
        self.separator = separator
        self.outward = outward
        self.linked = linked
        self.act = act
        self.action = action
    }

    public var body: some View {
        if let action {
            Button(action: action) { face }.buttonStyle(Cockpit.Pressable.row(platform, selected: false, forced: nil))
        } else {
            face
        }
    }

    private var marked: Bool { outward || action != nil || linked }

    @ViewBuilder private var mark: some View {
        if outward {
            Icon(.openOut, size: .xs).foregroundStyle(Cockpit.Color.accent)
        } else {
            Icon(.forward, size: platform == .ios ? .sm : .xs)
                .foregroundStyle(Cockpit.Color.textTertiary)
                .padding(.trailing, platform == .ios ? -4 : 0)
        }
    }

    private var lines: (first: String, second: String?) {
        let parts = value.split(separator: "\n", maxSplits: 1).map(String.init)
        return (parts.first ?? value, parts.count > 1 ? parts[1] : nil)
    }

    private var face: some View {
        KeyValueLayout(column: column, stacks: platform == .ios ? stacked : false) {
            Text(key)
                .cockpit(.subhead)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(alignment: .firstTextBaseline, spacing: Cockpit.Gap.inRow) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(lines.first.breakingAddresses)
                        .accessibilityLabel(lines.first)
                        .cockpit(.body)
                        .foregroundStyle(Cockpit.Color.text)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if let second = lines.second {
                        Text(second.breakingAddresses)
                            .accessibilityLabel(second)
                            .cockpit(Cockpit.Style.iosSubhead)
                            .foregroundStyle(Cockpit.Color.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if marked {
                    Spacer(minLength: Cockpit.Space.s2)
                    mark.hidden()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, platform.rowInset)
        .padding(.vertical, 15)
        .frame(minHeight: platform.rowHeight)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .trailing) {
            if marked { mark.padding(.trailing, platform.rowInset) }
        }
        .overlay(alignment: .trailing) {
            if let act {
                Button(act.words, action: act.perform)
                    .buttonStyle(.cockpit(platform == .ios ? .plain : .secondary, size: .small))
                    .accessibilityLabel(act.said)
                    .padding(.trailing, platform == .ios ? platform.rowInset - Cockpit.Space.s2 - 1 : platform.rowInset)
            }
        }
        .contentShape(Rectangle())
        .overlay(alignment: .bottom) {
            if separator {
                Rectangle().fill(Cockpit.Color.rule).frame(height: platform.ruleHeight).padding(.horizontal, platform.rowInset)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

public struct KeyValueRows<Content: View>: View {
    let content: Content
    @Environment(\.cockpitPlatform) private var platform

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        if platform == .ios {
            ViewThatFits(in: .horizontal) {
                rows(at: 0.5, stacked: false)
                rows(at: 0.5, stacked: true)
            }
        } else {
            ViewThatFits(in: .horizontal) {
                rows(at: 0.5)
                rows(at: 0.42)
                rows(at: 0.38)
                rows(at: 0.34)
            }
        }
    }

    private func rows(at column: CGFloat, stacked: Bool? = nil) -> some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .environment(\.cockpitKeyColumn, column)
            .environment(\.cockpitKeyStacked, stacked)
    }
}

extension EnvironmentValues {
    @Entry var cockpitKeyColumn: CGFloat = 0.5
    @Entry var cockpitKeyStacked: Bool? = nil
    @Entry var drawerCloses = true
}

struct KeyValueLayout: Layout {
    let column: CGFloat
    var stacks: Bool? = false
    private let gap = Cockpit.Space.s3
    private let under: CGFloat = 2

    private func widths(_ width: CGFloat) -> (key: CGFloat, value: CGFloat) {
        (max(width * column - gap, 0), width * (1 - column))
    }

    private func stacked(_ width: CGFloat, _ subviews: Subviews) -> Bool {
        stacks ?? (subviews[1].sizeThatFits(.unspecified).width > widths(width).value + 0.5)
    }

    private func arranged(_ width: CGFloat, _ subviews: Subviews) -> (key: CGFloat, value: CGFloat, height: CGFloat) {
        let (keyWidth, valueWidth) = widths(width)
        let key = subviews[0].dimensions(in: ProposedViewSize(width: keyWidth, height: nil))
        let value = subviews[1].dimensions(in: ProposedViewSize(width: valueWidth, height: nil))
        let baseline = max(key[.firstTextBaseline], value[.firstTextBaseline])
        let keyTop = baseline - key[.firstTextBaseline], valueTop = baseline - value[.firstTextBaseline]
        return (keyTop, valueTop, max(keyTop + key.height, valueTop + value.height))
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard subviews.count == 2 else { return .zero }
        let width: CGFloat
        if let proposed = proposal.width, proposed.isFinite {
            width = proposed
        } else {
            let key = subviews[0].sizeThatFits(.unspecified).width
            let value = subviews[1].sizeThatFits(.unspecified).width
            width = max((key + gap) / column, value / (1 - column))
        }
        if stacked(width, subviews) {
            let along = ProposedViewSize(width: width, height: nil)
            return CGSize(width: width, height: subviews[0].sizeThatFits(along).height + under + subviews[1].sizeThatFits(along).height)
        }
        return CGSize(width: width, height: arranged(width, subviews).height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 2 else { return }
        if stacked(bounds.width, subviews) {
            let along = ProposedViewSize(width: bounds.width, height: nil)
            let key = subviews[0].sizeThatFits(along).height
            subviews[0].place(at: CGPoint(x: bounds.minX, y: bounds.minY), proposal: along)
            subviews[1].place(at: CGPoint(x: bounds.minX, y: bounds.minY + key + under), proposal: along)
            return
        }
        let (keyWidth, valueWidth) = widths(bounds.width)
        let tops = arranged(bounds.width, subviews)
        subviews[0].place(at: CGPoint(x: bounds.minX, y: bounds.minY + tops.key), proposal: ProposedViewSize(width: keyWidth, height: nil))
        subviews[1].place(at: CGPoint(x: bounds.minX + bounds.width * column, y: bounds.minY + tops.value),
                          proposal: ProposedViewSize(width: valueWidth, height: nil))
    }
}

struct DrawerMeasured: ViewModifier {
    @Binding var height: CGFloat?
    var under: Binding<Double>? = nil

    func body(content: Content) -> some View {
        if #available(macOS 15, *) {
            content
                .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, measured in height = measured }
                .onScrollGeometryChange(for: Double.self) { ScrollFade.strength($0) } action: { _, amount in under?.wrappedValue = amount }
        } else {
            content
        }
    }
}

public enum DrawerFit: Sendable { case hugs, medium, large }

private struct DrawerRest: ViewModifier {
    let rest: DrawerFit
    @State private var held: CGFloat?
    @State private var strip: CGFloat = 0
    @State private var rested: PresentationDetent
    @State private var shows: String?
    @State private var kept: Set<PresentationDetent>?

    init(rest: DrawerFit) {
        self.rest = rest
        _rested = State(initialValue: rest == .large ? .large : .medium)
    }

    private var asked: CGFloat? { held.map { Cockpit.sheetAsked($0, strip: strip) } }

    private var detents: Set<PresentationDetent> {
        if let kept { return kept }
        return switch rest {
        case .hugs: Cockpit.sheetDetents(asked)
        case .medium: [.medium]
        case .large: [.large]
        }
    }

    private func settle() {
        guard rest == .hugs, kept == nil, let asked else { return }
        if asked < Cockpit.sheetHugLimit {
            rested = .height(asked)
        } else if !Cockpit.sheetDetents(asked).contains(rested) {
            rested = .medium
        }
    }

    func body(content: Content) -> some View {
        content
            .cockpitSheet()
            .onSheetFootChange {
                strip = max(strip, $0)
                settle()
            }
            .onPreferenceChange(SheetContentHeight.self) { measured in
                held = measured
                settle()
            }
            .onPreferenceChange(SheetShows.self) { now in
                if kept == nil, shows != nil, now != shows { kept = detents.union([rested]) }
                shows = now
            }
            .presentationDetents(detents, selection: $rested)
            .presentationDragIndicator(.visible)
            .presentationBackground(Cockpit.Color.surface)
            .environment(\.cockpitRowsClose, true)
    }
}

public struct SheetShows: PreferenceKey {
    public static let defaultValue: String? = nil
    public static func reduce(value: inout String?, nextValue: () -> String?) { value = nextValue() ?? value }
}

public extension View {
    func sheetShows(_ view: String?) -> some View { preference(key: SheetShows.self, value: view) }

    func drawerRest(_ rest: DrawerFit = .hugs) -> some View { modifier(DrawerRest(rest: rest)) }

    func drawerClosedByFoot() -> some View { environment(\.drawerCloses, false) }
}
