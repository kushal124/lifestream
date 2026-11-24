import SwiftUI

public struct DrawerPush: Sendable {
    public let back: String
    public let close: @MainActor @Sendable () -> Void

    public init(back: String, close: @escaping @MainActor @Sendable () -> Void) {
        self.back = back
        self.close = close
    }
}

public struct DrawerTitle: PreferenceKey {
    public static let defaultValue: String? = nil
    public static func reduce(value: inout String?, nextValue: () -> String?) { value = value ?? nextValue() }
}

public extension EnvironmentValues {
    @Entry var drawerPush: DrawerPush? = nil
    @Entry var drawerAsPage = false
}

#if os(iOS)
public struct PageDrawer<Content: View, Foot: View>: View {
    let title: String
    let icon: Cockpit.Icon?
    let tiled: Bool
    let line: String?
    let lineBusy: Bool
    let content: Content
    let foot: Foot
    @Environment(\.dismiss) private var dismiss
    @Environment(\.drawerCloses) private var closes
    @Environment(\.drawerPush) private var push
    @Environment(\.drawerAsPage) private var asPage
    @State private var scrolled = false
    @State private var headHeight: CGFloat = 0

    public init(_ title: String, icon: Cockpit.Icon? = nil, tiled: Bool = false, line: String? = nil, lineBusy: Bool = false,
                @ViewBuilder content: () -> Content, @ViewBuilder foot: () -> Foot) {
        self.title = title
        self.icon = icon
        self.tiled = tiled
        self.line = line
        self.lineBusy = lineBusy
        self.content = content()
        self.foot = foot()
    }

    private var hasFoot: Bool { Foot.self != EmptyView.self }

    public var body: some View {
        if asPage {
            page.preference(key: DrawerTitle.self, value: title)
        } else {
            SheetMargined { margin in framed(margin) }
                .toolbar(.hidden, for: .navigationBar)
                .swipesBack(push != nil)
                .preference(key: DrawerTitle.self, value: title)
        }
    }

    private var page: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Cockpit.Gap.section) {
                if !title.isEmpty || line?.isEmpty == false { pageHead }
                SheetStack { content }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .environment(\.cockpitRowsFaces, Cockpit.listFace)
            }
            .padding(.horizontal, Cockpit.Gap.edge)
            .padding(.vertical, Cockpit.Gap.head)
        }
        .groundColor(Cockpit.Color.canvas)
        .barTitle(title)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if hasFoot {
                if #available(iOS 18, macOS 15, *) {
                    Group(subviews: foot) { parts in
                        if !parts.isEmpty { pageFoot(parts) }
                    }
                } else {
                    pageFoot(foot)
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var pageHead: some View {
        let centred = icon != nil
        return VStack(alignment: centred ? .center : .leading, spacing: Cockpit.Gap.inRow) {
            if let icon {
                Circle()
                    .fill(Cockpit.Color.raised)
                    .frame(width: Cockpit.Size.avatarHead, height: Cockpit.Size.avatarHead)
                    .overlay { Icon(icon, size: .lg).foregroundStyle(Cockpit.Color.textSecondary) }
                    .padding(.bottom, Cockpit.Space.s2)
                    .accessibilityHidden(true)
            }
            Text(title)
                .cockpit(.title1)
                .foregroundStyle(Cockpit.Color.text)
                .multilineTextAlignment(centred ? .center : .leading)
                .lineLimit(3)
                .minimumScaleFactor(0.75)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .fadesIntoBar()
            if let line, !line.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s2) {
                    if lineBusy { Loading(size: .glyph).accessibilityHidden(true) }
                    Text(line)
                        .cockpit(.subhead)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .multilineTextAlignment(centred ? .center : .leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: centred ? .center : .leading)
    }

    private func pageFoot<Parts: View>(_ parts: Parts) -> some View {
        HStack(spacing: Cockpit.Space.s3) { parts }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, Cockpit.Gap.edge)
            .padding(.top, Cockpit.Space.s3)
            .padding(.bottom, Cockpit.Space.s2)
            .groundColor(Cockpit.Color.canvas)
    }

    private func framed(_ margin: CGFloat) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Cockpit.Gap.head - Cockpit.Space.s1) {
                head
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { headHeight = $0 }
                SheetStack { content }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .environment(\.cockpitRowsFaces, Cockpit.listFace)
            }
            .padding(.horizontal, margin)
            .padding(.top, push == nil ? Cockpit.Gap.edge + Cockpit.Space.s2 : Cockpit.Space.s1)
            .padding(.bottom, Cockpit.Gap.head)
        }
        .scrollBounceBehavior(.basedOnSize)
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.contentOffset.y + geometry.contentInsets.top > max(headHeight - Cockpit.Space.s4, Cockpit.Space.s4)
        } action: { _, now in
            withAnimation(.easeOut(duration: 0.15)) { scrolled = now }
        }
        .safeAreaInset(edge: .top, spacing: 0) { bar(margin) }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if hasFoot {
                if #available(iOS 18, macOS 15, *) {
                    Group(subviews: foot) { parts in
                        if !parts.isEmpty { footBar(parts, margin) }
                    }
                } else {
                    footBar(foot, margin)
                }
            }
        }
        .groundColor(Cockpit.Color.surface)
        .cockpitSheet()
        .accessibilityElement(children: .contain)
    }

    private func footBar<Parts: View>(_ parts: Parts, _ margin: CGFloat) -> some View {
        HStack(spacing: Cockpit.Space.s3) { parts }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, margin)
            .padding(.top, Cockpit.Space.s3)
            .padding(.bottom, Cockpit.Space.s2)
            .groundColor(Cockpit.Color.surface)
            .overlay(alignment: .top) { Rectangle().fill(Cockpit.Color.rule).frame(height: Cockpit.Stroke.border) }
    }

    private func bar(_ margin: CGFloat) -> some View {
        ZStack {
            Text(title)
                .cockpit(.headline)
                .foregroundStyle(Cockpit.Color.text)
                .cockpitLines(1)
                .padding(.horizontal, push == nil ? DrawerCircle.side + Cockpit.Space.s3 : Self.backRoom)
                .frame(maxWidth: .infinity)
                .opacity(scrolled ? 1 : 0)
                .accessibilityHidden(true)
            HStack(spacing: Cockpit.Space.s3) {
                if let push {
                    DrawerBack(push.back) { dismiss() }
                }
                Spacer(minLength: 0)
                if closes {
                    DrawerClose { if let push { push.close() } else { dismiss() } }
                } else {
                    Color.clear.frame(width: DrawerCircle.side, height: DrawerCircle.side)
                }
            }
        }
        .frame(minHeight: DrawerCircle.side)
        .padding(.horizontal, margin)
        .padding(.top, Cockpit.Gap.edge)
        .padding(.bottom, Cockpit.Space.s2)
        .background(Cockpit.Color.surface.opacity(scrolled ? 1 : 0))
        .overlay(alignment: .bottom) {
            Rectangle().fill(Cockpit.Color.rule).frame(height: Cockpit.Stroke.border).opacity(scrolled ? 1 : 0)
        }
        .padding(.bottom, push == nil ? -(Cockpit.Gap.edge + DrawerCircle.side + Cockpit.Space.s2) : 0)
    }

    private static var backRoom: CGFloat { 104 }

    @ViewBuilder private var head: some View {
        if tiled, let icon {
            HStack(alignment: .center, spacing: Cockpit.Space.s4) {
                IconTile(icon, side: Cockpit.Size.target, radius: Cockpit.Radius.sm)
                    .accessibilityHidden(true)
                words(icon: nil, title: .title2)
            }
            .opacity(scrolled ? 0 : 1)
        } else {
            words(icon: icon, title: push == nil ? .title2 : .title1)
        }
    }

    private func words(icon: Cockpit.Icon?, title style: Cockpit.Role) -> some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
            HStack(alignment: .center, spacing: Cockpit.Space.s3) {
                if let icon, push == nil {
                    Icon(icon, size: .md)
                        .foregroundStyle(Cockpit.Color.text)
                        .frame(width: Cockpit.Space.s6)
                        .accessibilityHidden(true)
                }
                Text(title)
                    .cockpit(style)
                    .foregroundStyle(Cockpit.Color.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
            }
            .padding(.trailing, push == nil ? DrawerCircle.side + Cockpit.Space.s2 : 0)
            .opacity(scrolled ? 0 : 1)
            if let line, !line.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s2) {
                    if lineBusy { Loading(size: .glyph).accessibilityHidden(true) }
                    Text(line)
                        .cockpit(.subhead)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.leading, icon == nil || push != nil ? 0 : Cockpit.Space.s6 + Cockpit.Space.s3)
                .accessibilityIdentifier("sheet.line")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct DrawerBack: View {
    let name: String
    let action: () -> Void

    init(_ name: String, action: @escaping () -> Void) {
        self.name = name
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: Cockpit.Space.s1) {
                Icon(.back, size: .sm)
                Text(name).cockpit(.body).cockpitLines(1)
            }
            .foregroundStyle(Cockpit.Color.text)
            .frame(minHeight: DrawerCircle.side)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressedDim())
        .accessibilityLabel("Back to \(name)")
        .accessibilityIdentifier("drawer.back")
    }
}

public extension PageDrawer where Foot == EmptyView {
    init(_ title: String, icon: Cockpit.Icon? = nil, tiled: Bool = false, line: String? = nil, lineBusy: Bool = false,
         @ViewBuilder content: () -> Content) {
        self.init(title, icon: icon, tiled: tiled, line: line, lineBusy: lineBusy, content: content, foot: { EmptyView() })
    }
}
#endif

public struct StepRow<Content: View>: View {
    let number: Int
    let done: Bool
    let later: Bool
    let title: String
    let words: String?
    let separator: Bool
    let content: Content

    public init(_ number: Int, done: Bool = false, later: Bool = false, title: String, words: String? = nil, separator: Bool = true,
                @ViewBuilder content: () -> Content) {
        self.number = number
        self.done = done
        self.later = later
        self.title = title
        self.words = words
        self.separator = separator
        self.content = content()
    }

    private static var mark: CGFloat { 24 }

    public var body: some View {
        HStack(alignment: .top, spacing: Cockpit.Space.s3) {
            ZStack {
                if done {
                    Circle().fill(Cockpit.Color.text)
                    Icon(.done, size: .xs).foregroundStyle(Cockpit.Color.surface)
                } else {
                    Circle().strokeBorder(Cockpit.Color.border, lineWidth: Cockpit.Stroke.border)
                    Text("\(number)").cockpit(.caption).monospacedDigit()
                        .foregroundStyle(later ? Cockpit.Color.textTertiary : Cockpit.Color.textSecondary)
                }
            }
            .frame(width: Self.mark, height: Self.mark)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
                Text(title)
                    .cockpit(.rowTitle)
                    .foregroundStyle(later ? Cockpit.Color.textTertiary : Cockpit.Color.text)
                    .fixedSize(horizontal: false, vertical: true)
                if let words, !words.isEmpty {
                    Text(words)
                        .cockpit(.body)
                        .foregroundStyle(later ? Cockpit.Color.textTertiary : Cockpit.Color.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                content
                    .padding(.top, Content.self == EmptyView.self ? 0 : Cockpit.Space.s2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 1)
        }
        .padding(.vertical, Cockpit.Space.s3)
        .overlay(alignment: .bottom) {
            if separator {
                Rectangle().fill(Cockpit.Color.rule).frame(height: Cockpit.Stroke.border)
                    .padding(.leading, Self.mark + Cockpit.Space.s3)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(done ? "Done: \(title)" : "Step \(number): \(title)")
    }
}

public extension StepRow where Content == EmptyView {
    init(_ number: Int, done: Bool = false, later: Bool = false, title: String, words: String? = nil, separator: Bool = true) {
        self.init(number, done: done, later: later, title: title, words: words, separator: separator) { EmptyView() }
    }
}

public struct WaitTag: View {
    let words: String

    public init(_ words: String) { self.words = words }

    public var body: some View {
        HStack(spacing: Cockpit.Space.s1) {
            Icon(.time, size: .xs).accessibilityHidden(true)
            Text(words).cockpit(.footnote)
        }
        .foregroundStyle(Cockpit.Color.textSecondary)
        .padding(.horizontal, Cockpit.Space.s2)
        .padding(.vertical, Cockpit.Space.s1)
        .background(Capsule().fill(Cockpit.Color.raised))
    }
}
