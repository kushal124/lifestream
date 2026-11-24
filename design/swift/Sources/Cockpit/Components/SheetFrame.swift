import SwiftUI

public struct SheetContentHeight: PreferenceKey {
    public static let defaultValue: CGFloat? = nil
    public static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) { value = nextValue() ?? value }
}

public extension Cockpit {
    static func sheetDetents(_ content: CGFloat?) -> Set<PresentationDetent> {
        guard let content else { return [.medium, .large] }
        return content < sheetHugLimit ? [.height(content)] : [.medium, .large]
    }

    static let sheetHugLimit: CGFloat = 640

    static let sheetCorner: CGFloat = 38

    private static let sheetFloats: CGFloat = 150

    static func sheetAsked(_ content: CGFloat, strip: CGFloat) -> CGFloat {
        content <= sheetFloats ? content : max(content - strip, sheetFloats + 1)
    }
}

public struct SheetFrame<Content: View, Words: View, Acts: View>: View {
    let title: String
    let icon: Cockpit.Icon?
    let line: String?
    let content: Content
    let words: Words
    let acts: Acts
    @Environment(\.cockpitPlatform) private var platform

    public init(_ title: String, icon: Cockpit.Icon? = nil, line: String? = nil,
                @ViewBuilder content: () -> Content, @ViewBuilder words: () -> Words, @ViewBuilder acts: () -> Acts) {
        self.title = title
        self.icon = icon
        self.line = line
        self.content = content()
        self.words = words()
        self.acts = acts()
    }

    public var body: some View {
        switch platform {
        case .ios:
            Drawer(title, facts: line) {
                content
            } foot: {
                if hasFoot { foot }
            }
        case .mac:
            VStack(alignment: .leading, spacing: 0) {
                page.padding(.bottom, Cockpit.Space.s5)
                if hasFoot { foot }
            }
            .frame(width: 480, alignment: .leading)
            .groundColor(Cockpit.Color.surface)
        }
    }

    private var margin: CGFloat { platform.margin }
    private var hasFoot: Bool { Words.self != EmptyView.self || Acts.self != EmptyView.self }

    private var page: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s5) {
            head
            MacParts { content }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, margin)
        .padding(.top, Cockpit.Space.s5)
    }

    private var head: some View {
        HStack(alignment: .top, spacing: Cockpit.Space.s4) {
            if let icon {
                Icon(icon, size: .md)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .frame(width: Cockpit.Space.s10, height: Cockpit.Space.s10)
                    .background(RoundedRectangle(cornerRadius: Cockpit.Space.s3, style: .continuous).fill(Cockpit.Color.raised))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .cockpit(.title2)
                    .foregroundStyle(Cockpit.Color.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if let line {
                    Text(line)
                        .cockpit(.subhead)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .lineLimit(platform == .ios ? 2 : 1)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.top, icon == nil ? 0 : 2)
        }
    }

    private var foot: some View {
        HStack(spacing: Cockpit.Space.s2) {
            words
                .cockpit(.subhead)
                .foregroundStyle(Cockpit.Color.textSecondary)
            Spacer(minLength: Cockpit.Space.s2)
            acts
        }
        .padding(.horizontal, platform == .ios ? 0 : margin)
        .padding(.vertical, platform == .ios ? 0 : 14)
        .frame(maxWidth: .infinity)
        .groundColor(Cockpit.Color.surface)
        .overlay(alignment: .top) {
            if platform == .mac { Rectangle().fill(Cockpit.Color.rule).frame(height: Cockpit.Stroke.border) }
        }
    }
}

public extension SheetFrame where Words == EmptyView {
    init(_ title: String, icon: Cockpit.Icon? = nil, line: String? = nil,
         @ViewBuilder content: () -> Content, @ViewBuilder acts: () -> Acts) {
        self.init(title, icon: icon, line: line, content: content, words: { EmptyView() }, acts: acts)
    }
}

public extension SheetFrame where Words == EmptyView, Acts == EmptyView {
    init(_ title: String, icon: Cockpit.Icon? = nil, line: String? = nil,
         @ViewBuilder content: () -> Content) {
        self.init(title, icon: icon, line: line, content: content, words: { EmptyView() }, acts: { EmptyView() })
    }
}

public struct SheetPart<Content: View>: View {
    let label: String?
    let about: String?
    let line: String?
    let note: String?
    let aside: String?
    let action: String?
    let perform: (() -> Void)?
    let actionIdentifier: String?
    let content: Content
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.cockpitPartsFlat) private var flat

    public init(_ label: String?, about: String? = nil, line: String? = nil, note: String? = nil, aside: String? = nil,
                action: String? = nil, perform: (() -> Void)? = nil, actionIdentifier: String? = nil,
                @ViewBuilder content: () -> Content) {
        self.label = label
        self.about = about
        self.line = line
        self.note = note
        self.aside = aside
        self.action = action
        self.perform = perform
        self.actionIdentifier = actionIdentifier
        self.content = content()
    }

    public var body: some View {
        drawn
            .environment(\.inSettingSection, true)
            .frame(maxWidth: .infinity, alignment: .leading)
        .layoutValue(key: SheetStack.Labelled.self, value: label != nil)
    }

    @ViewBuilder private var drawn: some View {
        if #available(iOS 18, macOS 15, *) {
            Group(subviews: content) { rows in
                if !rows.isEmpty { section(rows) }
            }
        } else {
            section(content)
        }
    }

    @ViewBuilder private func section<Rows: View>(_ rows: Rows) -> some View {
        if platform == .ios, flat {
            VStack(alignment: .leading, spacing: 0) {
                if let label { SectionLabel(label, action: action, perform: perform, actionIdentifier: actionIdentifier, aside: aside) }
                Card(group: true, flat: true) { rows }
                if let note {
                    Text(note).settingLine().padding(.top, Cockpit.Space.s2)
                }
            }
        } else {
            boxed(rows)
        }
    }

    private func boxed<Rows: View>(_ rows: Rows) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if label != nil || line != nil {
                VStack(alignment: .leading, spacing: 2) {
                    if let label {
                        HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s1) {
                            Text(label)
                                .cockpit(Self.heading)
                                .foregroundStyle(Cockpit.Color.text)
                                .accessibilityAddTraits(.isHeader)
                            if let about { InfoMark(about, label: label) }
                            if let aside {
                                Spacer(minLength: Cockpit.Space.s3)
                                SectionAside(words: aside)
                            }
                            if let action {
                                Spacer(minLength: Cockpit.Space.s3)
                                Button(action) { perform?() }
                                    .buttonStyle(.cockpit(.plain, size: .small))
                                    .accessibilityIdentifier(actionIdentifier ?? "")
                            }
                        }
                    }
                    if let line {
                        Text(line).settingLine().frame(maxWidth: 60 * 7, alignment: .leading)
                    }
                }
                .padding(.horizontal, platform == .ios ? Cockpit.Space.s4 : 0)
                .padding(.bottom, platform == .ios ? Cockpit.Space.s2 : Cockpit.Space.s1)
            }
            if platform == .ios {
                Card(group: true) { rows }
            } else {
                VStack(alignment: .leading, spacing: 0) { rows }
            }
            if let note {
                Text(note).settingLine()
                    .padding(.horizontal, platform == .ios ? Cockpit.Space.s4 : 0)
                    .padding(.top, Cockpit.Space.s2)
            }
        }
    }

    static var heading: Cockpit.TextStyle {
        let title = Cockpit.Style.iosRowTitle
        return Cockpit.TextStyle(size: title.size, lineHeight: title.lineHeight, weight: 600, design: title.design,
                                 textStyle: title.textStyle, tracking: title.tracking, italic: false, tabular: false, uppercase: false)
    }
}

public extension EnvironmentValues {
    @Entry var cockpitPartsFlat = false
}

public extension View {
    func onSheetFootChange(_ action: @escaping (CGFloat) -> Void) -> some View {
        modifier(SheetFootReader(action: action))
    }
}

private struct SheetFootReader: ViewModifier {
    let action: (CGFloat) -> Void

    @MainActor private var strip: CGFloat {
        #if os(iOS)
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first?.safeAreaInsets.bottom ?? .infinity
        #else
        .infinity
        #endif
    }

    func body(content: Content) -> some View {
        let strip = strip
        content.onGeometryChange(for: CGFloat.self) { min($0.safeAreaInsets.bottom, strip) } action: { action($0) }
    }
}

struct SheetStack: Layout {
    var group = Cockpit.Gap.group
    var section = Cockpit.Gap.section
    struct Labelled: LayoutValueKey { static let defaultValue = false }
    struct Heads: LayoutValueKey { static let defaultValue = false }

    private func gaps(_ subviews: Subviews, width: CGFloat?) -> [CGFloat] {
        var first = true
        var headed = false
        return subviews.map { subview in
            guard subview.sizeThatFits(ProposedViewSize(width: width, height: nil)).height > 0 else { return 0 }
            defer { first = false; headed = subview[Heads.self] }
            return first ? 0 : headed ? Cockpit.Gap.tabs : subview[Labelled.self] ? section : group
        }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let sizes = subviews.map { $0.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil)) }
        return CGSize(width: proposal.width ?? sizes.map(\.width).max() ?? 0,
                      height: sizes.map(\.height).reduce(0, +) + gaps(subviews, width: proposal.width).reduce(0, +))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let along = ProposedViewSize(width: bounds.width, height: nil)
        var top = bounds.minY
        for (subview, gap) in zip(subviews, gaps(subviews, width: bounds.width)) {
            top += gap
            subview.place(at: CGPoint(x: bounds.minX, y: top), anchor: .topLeading, proposal: along)
            top += subview.sizeThatFits(along).height
        }
    }
}

private struct MacParts<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        SheetStack(group: Cockpit.Space.s4, section: 36) { content }
    }
}

public struct SheetPage<Content: View>: View {
    let title: String
    let content: Content
    @Environment(\.cockpitPlatform) private var platform
    @State private var height: CGFloat?
    @State private var safeFoot: CGFloat = 0

    private static var bar: CGFloat { 56 }

    public init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    @ViewBuilder private var stack: some View {
        if platform == .ios {
            SheetStack { content }
        } else {
            MacParts { content }
        }
    }

    public var body: some View {
        SheetMargined { margin in framed(margin) }
    }

    private func framed(_ margin: CGFloat) -> some View {
        ScrollView {
            stack
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, platform == .ios ? margin : platform.margin)
                .padding(.top, Cockpit.Space.s3)
                .padding(.bottom, platform == .ios ? Cockpit.Gap.edge : Cockpit.Space.s5)
        }
        .modifier(DrawerMeasured(height: $height))
        .onSheetFootChange { safeFoot = $0 }
        .preference(key: SheetContentHeight.self, value: height.map { $0 + Self.bar + safeFoot })
        .groundColor(Cockpit.Color.surface)
        .tint(Cockpit.Color.text)
        .navigationTitle(title)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .sheetBack(margin: margin)
        #endif
    }
}

#if os(iOS)
private struct SheetBack: ViewModifier {
    let margin: CGFloat
    @Environment(\.dismiss) private var dismiss

    func body(content: Content) -> some View {
        content
            .navigationBarBackButtonHidden(true)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    SheetPillCircle(margin: margin) { dismiss() }
                }
                .sharedBackgroundVisibility(.hidden)
            }
            .background(SwipeBack())
    }
}

public extension View {
    func sheetBack(margin: CGFloat = Cockpit.Gap.sheet) -> some View { modifier(SheetBack(margin: margin)) }

    @ViewBuilder func swipesBack(_ on: Bool) -> some View {
        if on { background(SwipeBack()) } else { self }
    }
}
#endif

#if os(iOS)
private struct SwipeBack: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController { UIViewController() }

    func updateUIViewController(_ controller: UIViewController, context: Context) {
        DispatchQueue.main.async {
            controller.navigationController?.interactivePopGestureRecognizer?.isEnabled = true
            controller.navigationController?.interactivePopGestureRecognizer?.delegate = nil
        }
    }
}
#endif
