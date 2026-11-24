import SwiftUI

enum BarFade {
    static let fadeBegins = 1.0
    static let titleEnds = 0.4
    static let barBegins = 0.4
    static let barWhole = 0.0
    static let rise: CGFloat = 6

    static func strength(midY: CGFloat, barBottom: CGFloat?, ends: Double) -> Double {
        guard let barBottom, barBottom > 0 else { return 1 }
        let y = midY + barBottom, begins = fadeBegins * barBottom, ends = ends * barBottom
        return min(1, max(0, (y - ends) / (begins - ends)))
    }

    static func bar(_ title: Double) -> Double {
        min(1, max(0, (barBegins - title) / (barBegins - barWhole)))
    }
}

@MainActor @Observable final class BarTitleStrength {
    private(set) var value = 0.0

    func set(_ value: Double) {
        guard value != self.value else { return }
        self.value = value
    }
}

@MainActor @Observable final class BarScrolled {
    private(set) var reported = false
    private(set) var offset: CGFloat = 0

    func moved(_ offset: CGFloat) {
        if !reported { reported = true }
        let held = min(max(offset, 0), RootFold.span)
        guard held != self.offset else { return }
        self.offset = held
    }

    var title: Double { reported ? RootFold.title(offset) : 1 }
    var folded: Double { reported ? RootFold.small(offset) : 0 }
}

enum RootFold {
    static let span: CGFloat = 64
    static let titleGone: CGFloat = 40
    static let smallBegins: CGFloat = 26
    static let smallWhole: CGFloat = 44

    static func title(_ offset: CGFloat) -> Double { Double(max(0, 1 - offset / titleGone)) }
    static func small(_ offset: CGFloat) -> Double { Double(min(1, max(0, (offset - smallBegins) / (smallWhole - smallBegins)))) }
}

extension EnvironmentValues {
    @Entry var barScrolled: BarScrolled?
    @Entry var barBottom: CGFloat?
    @Entry var barTitleStrength: BarTitleStrength?
    @Entry var barFadeForced: Double?
}

public extension View {
    func barTitle(_ title: String) -> some View {
        modifier(BarTitleMeasured(current: true)).modifier(BarTitled(title: title))
    }

    func barTitleScroll(current: Bool) -> some View {
        modifier(BarTitleMeasured(current: current))
    }

    func rootBar(_ name: String, small: String? = nil, presses: SmallTitlePress? = nil, pinsFoot: Bool = true,
                 raisesFoot: Bool = false, sheet: Bool = false, margin: CGFloat = Cockpit.Gap.sheet, @ViewBuilder title: () -> some View,
                 @ViewBuilder controls: () -> some View) -> some View {
        modifier(RootBar(name: name, small: small ?? name, presses: presses, pinsFoot: pinsFoot, raisesFoot: raisesFoot, sheet: sheet,
                         margin: margin, title: title(), controls: controls()))
    }

    func floatingBar(_ name: String, title: String? = nil, @ViewBuilder leading: () -> some View,
                     @ViewBuilder trailing: () -> some View) -> some View {
        modifier(FloatingBar(name: name, title: title, leading: leading(), trailing: trailing()))
    }

    func foldsOnRootLine() -> some View {
        modifier(RootLineFold())
    }

    func fadesIntoBar() -> some View {
        modifier(FadesIntoBar())
    }
}

public struct RootTitle: View {
    let title: String

    public init(_ title: String) {
        self.title = title
    }

    public var body: some View {
        Text(title)
            .cockpit(.display)
            .foregroundStyle(Cockpit.Color.text)
            .rootTitleLine()
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("root.title")
            .foldsOnRootLine()
    }
}

public extension Cockpit {
    static let sheetFace: CGFloat = 36
    static let listFace: CGFloat = Size.avatarRow
    static let sheetBarInset: CGFloat = 20
}

extension View {
    func titleHalo() -> some View { modifier(TitleHalo()) }
}

private struct TitleHalo: ViewModifier {
    @Environment(\.cockpitInSheet) private var inSheet

    func body(content: Content) -> some View {
        let ground = inSheet ? Cockpit.Color.surface : Cockpit.Color.canvas
        content.shadow(color: ground, radius: 2).shadow(color: ground, radius: 4)
    }
}

public extension View {
    func barSlot() -> some View { modifier(BarSlot()) }

    func rootTitleLine() -> some View {
        lineLimit(1).minimumScaleFactor(0.6).dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }
}

#if os(iOS)
public extension View {
    func sheetCloseBar(_ close: (() -> Void)? = nil) -> some View { modifier(SheetCloseBar(close: close)) }
}

private struct SheetCloseBar: ViewModifier {
    let close: (() -> Void)?
    @Environment(\.dismiss) private var dismiss

    func body(content: Content) -> some View {
        content.toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                DrawerClose { if let close { close() } else { dismiss() } }
                    .padding(.trailing, Cockpit.Gap.sheet - Cockpit.sheetBarInset)
            }
            .sharedBackgroundVisibility(.hidden)
        }
    }
}

struct SheetPillCircle: View {
    let margin: CGFloat
    let action: () -> Void
    @Environment(\.cockpitSheetScale) private var scale

    var body: some View {
        let side = Cockpit.Size.target / scale, face = Cockpit.sheetFace / scale
        let room = margin - Cockpit.sheetBarInset
        let beside = min((side - face) / 2, room)
        Button(action: action) {
            Icon(.back, size: .sm)
                .foregroundStyle(Cockpit.Color.text)
                .frame(width: face, height: face)
                .background { SlotHeld(fill: Cockpit.Color.raised) }
                .padding(.leading, beside)
                .frame(width: side, height: side, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(SheetPress())
        .accessibilityLabel("Back")
        .accessibilityIdentifier("drawer.back")
        .padding(.leading, room - beside)
    }
}
#endif

private struct BarSlot: ViewModifier {
    @Environment(\.cockpitSheetScale) private var scale

    func body(content: Content) -> some View {
        content.frame(width: Cockpit.Size.target / scale, height: Cockpit.Size.target / scale)
            .background { SlotHeld().frame(width: Cockpit.sheetFace / scale, height: Cockpit.sheetFace / scale) }
            .contentShape(Rectangle())
    }
}

struct SlotHeld: View {
    var fill = Color.clear
    @Environment(\.sheetHeld) private var held

    var body: some View {
        Circle().fill(fill).overlay { if held { Circle().fill(Cockpit.Color.pressed) } }
    }
}

struct SheetPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.environment(\.sheetHeld, configuration.isPressed)
    }
}

extension EnvironmentValues {
    @Entry var sheetHeld = false
}

#if os(iOS)
public struct BarControls<Controls: View>: View {
    let controls: Controls
    @Environment(\.cockpitBarCovered) private var covered

    public init(@ViewBuilder _ controls: () -> Controls) {
        self.controls = controls()
    }

    public var body: some View {
        HStack(spacing: 0) { controls }
            .frame(height: Cockpit.Size.target)
            .glassEffect(covered ? .regular : .regular.interactive(), in: .capsule)
    }
}

public extension View {
    func floatingControls(@ViewBuilder _ controls: () -> some View) -> some View {
        safeAreaBar(edge: .top, spacing: 0) {
            BarControls(controls)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.trailing, Cockpit.Space.s4)
                .padding(.bottom, Cockpit.Space.s1)
        }
        .toolbar(.hidden, for: .navigationBar)
    }
}
#endif

private struct RootBar<Title: View, Controls: View>: ViewModifier {
    let name: String
    let small: String
    let presses: SmallTitlePress?
    let pinsFoot: Bool
    let raisesFoot: Bool
    let sheet: Bool
    let margin: CGFloat
    let title: Title
    let controls: Controls
    @Environment(\.rootBarFoot) private var foot
    @State private var scrolled = BarScrolled()

    func body(content: Content) -> some View {
        #if os(iOS)
        content
            .environment(\.barScrolled, scrolled)
            .safeAreaBar(edge: .top, spacing: 0) {
                VStack(spacing: 0) {
                    if !raised { line }
                    HStack(alignment: .bottom, spacing: 0) {
                        if !sheet, pinsFoot, let foot { foot }
                        if raised {
                            glassControls
                                .padding(.trailing, Cockpit.Space.s4)
                                .padding(.bottom, Cockpit.Space.s2)
                        }
                    }
                }
                .environment(\.barScrolled, scrolled)
            }
            .scrollEdgeEffectStyle(.soft, for: [.top, .bottom])
            .navigationTitle(name)
            .toolbar(.hidden, for: .navigationBar)
        #else
        content
        #endif
    }

    private var raised: Bool { raisesFoot && !sheet && pinsFoot && foot != nil }

    #if os(iOS)
    private var glassControls: some View {
        BarControls { controls }
    }

    private var line: some View {
        HStack(spacing: Cockpit.Space.s3) {
            title.frame(maxWidth: .infinity, alignment: .leading)
            if sheet {
                HStack(spacing: DrawerCircle.spacing) { controls }
            } else {
                glassControls
            }
        }
        .frame(height: Cockpit.Size.target)
        .padding(.leading, sheet ? margin : Cockpit.Gap.edge)
        .padding(.trailing, sheet ? margin : Cockpit.Space.s4)
        .padding(.top, sheet ? Cockpit.Space.s3 : 0)
        .padding(.bottom, Cockpit.Space.s1)
        .overlay { RootSmallTitle(title: small, presses: presses, scrolled: scrolled) }
    }
    #endif
}

private struct FloatingBar<Leading: View, Trailing: View>: ViewModifier {
    let name: String
    let title: String?
    let leading: Leading
    let trailing: Trailing
    @Environment(\.cockpitBarCovered) private var covered
    @Environment(\.rootBarFoot) private var foot
    @State private var scrolled = BarScrolled()

    func body(content: Content) -> some View {
        #if os(iOS)
        content
            .environment(\.barScrolled, scrolled)
            .safeAreaBar(edge: .top, spacing: 0) {
                VStack(spacing: 0) {
                    line
                    if let foot { foot }
                }
                .environment(\.barScrolled, scrolled)
            }
            .scrollEdgeEffectStyle(.soft, for: [.top, .bottom])
            .navigationTitle(name)
            .toolbar(.hidden, for: .navigationBar)
        #else
        content
        #endif
    }

    #if os(iOS)
    private var line: some View {
        GlassEffectContainer {
            HStack(spacing: 0) {
                glass(leading)
                Spacer(minLength: 0)
                glass(trailing)
            }
            .frame(height: Cockpit.Size.target)
        }
        .overlay { if let title { pill(title) } }
        .padding(.horizontal, Cockpit.Space.s4)
        .padding(.bottom, Cockpit.Space.s1)
    }

    private func pill(_ title: String) -> some View {
        Text(title)
            .cockpit(.subhead)
            .fontWeight(.semibold)
            .foregroundStyle(Cockpit.Color.text)
            .lineLimit(1)
            .truncationMode(.tail)
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            .padding(.horizontal, Cockpit.Space.s4)
            .frame(height: Cockpit.Size.target)
            // external: iOS 26 and 27 blur a soft scroll edge only under a visible label outside glass; under glass alone it only dims
            .background { Color.clear.glassEffect(.regular, in: .capsule) }
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("bar.title")
            .padding(.horizontal, Cockpit.Space.s4 + Cockpit.Size.target + Cockpit.Space.s6)
    }

    private func glass(_ control: some View) -> some View {
        HStack(spacing: 0) { control }
            .frame(minWidth: Cockpit.Size.target, minHeight: Cockpit.Size.target)
            .glassEffect(covered ? .regular : .regular.interactive(), in: .capsule)
    }
    #endif
}

extension EnvironmentValues {
    @Entry public var rootBarFoot: AnyView?
}

private struct RootLineFold: ViewModifier {
    @Environment(\.barScrolled) private var scrolled
    @Environment(\.accessibilityReduceMotion) private var still

    func body(content: Content) -> some View {
        let shown = scrolled?.title ?? 1
        content
            .opacity(shown)
            .offset(y: still ? 0 : -(scrolled?.reported == true ? scrolled?.offset ?? 0 : 0))
            .allowsHitTesting(shown > 0.5)
            .accessibilityHidden(shown <= 0)
    }
}

public struct SmallTitlePress {
    public let hint: String
    public let action: @MainActor () -> Void

    public init(hint: String, action: @escaping @MainActor () -> Void) {
        self.hint = hint
        self.action = action
    }
}

private struct RootSmallTitle: View {
    let title: String
    let presses: SmallTitlePress?
    let scrolled: BarScrolled
    @Environment(\.accessibilityReduceMotion) private var still

    var body: some View {
        let shown = scrolled.folded
        Group {
            if let presses {
                Button(action: presses.action) {
                    words.frame(height: Cockpit.Size.target).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint(presses.hint)
                .accessibilityAddTraits(.isHeader)
            } else {
                words
            }
        }
        .opacity(shown)
        .offset(y: still ? 0 : BarFade.rise * (1 - shown))
        .allowsHitTesting(presses != nil && shown > 0.5)
        .accessibilityHidden(shown < 1)
        .accessibilityIdentifier(shown < 1 ? "" : "bar.title")
    }

    private var words: some View {
        Text(title)
            .cockpit(.headline)
            .foregroundStyle(Cockpit.Color.text)
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: 200)
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            .titleHalo()
    }
}

private struct BarTitled: ViewModifier {
    let title: String
    @State private var strength = BarTitleStrength()

    func body(content: Content) -> some View {
        #if os(iOS)
        content
            .barBand()
            .environment(\.barTitleStrength, strength)
            .navigationTitle(title)
            .toolbarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { BarTitleLabel(title: title, strength: strength) }
                    .sharedBackgroundVisibility(.hidden)
            }
        #else
        content
            .barBand()
            .environment(\.barTitleStrength, strength)
            .navigationTitle(title)
            .toolbarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .principal) { BarTitleLabel(title: title, strength: strength) } }
        #endif
    }

}

public extension View {
    func barBand() -> some View { modifier(BarBand()) }
}

private struct BarBand: ViewModifier {
    func body(content: Content) -> some View {
        #if os(iOS)
        content.scrollEdgeEffectStyle(.soft, for: [.top, .bottom])
        #else
        content.overlay(alignment: .top) { BarGround() }
        #endif
    }
}

private struct BarTitleMeasured: ViewModifier {
    let current: Bool
    @State private var rest: CGFloat?
    @Environment(\.barTitleStrength) private var strength
    @Environment(\.barScrolled) private var scrolled

    func body(content: Content) -> some View {
        measured(content)
            .environment(\.barBottom, rest)
            .environment(\.barTitleStrength, current ? strength : nil)
    }

    @ViewBuilder private func measured(_ content: Content) -> some View {
        if #available(macOS 15, *) {
            content.onScrollGeometryChange(for: CGFloat.self) { $0.contentInsets.top } action: { _, top in rest = top }
                .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y + $0.contentInsets.top } action: { _, offset in
                    if current { scrolled?.moved(offset) }
                }
        } else {
            content
        }
    }
}

#if os(macOS)
private struct BarGround: View {
    @Environment(\.cockpitInSheet) private var inSheet
    private static let tabBar: CGFloat = 40

    var body: some View {
        let ground = inSheet ? Cockpit.Color.surface : Cockpit.Color.canvas
        GeometryReader { proxy in
            let foot = proxy.safeAreaInsets.bottom
            let top = proxy.safeAreaInsets.top
            let band = top + Cockpit.Space.s3
            LinearGradient(stops: [.init(color: ground, location: 0), .init(color: ground, location: band > 0 ? top / band : 0),
                                   .init(color: ground.opacity(0), location: 1)],
                           startPoint: .top, endPoint: .bottom)
                .frame(height: band)
                .offset(y: -top)
            if foot > Self.tabBar {
                let height = foot + Cockpit.Space.s6
                LinearGradient(stops: [.init(color: ground.opacity(0), location: 0),
                                       .init(color: ground, location: Cockpit.Space.s6 / height),
                                       .init(color: ground, location: 1)],
                               startPoint: .top, endPoint: .bottom)
                    .frame(height: height)
                    .offset(y: proxy.size.height - Cockpit.Space.s6)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
#endif

private struct FadesUnderBar: ViewModifier {
    let ends: Double
    @Environment(\.barBottom) private var barBottom
    @Environment(\.barFadeForced) private var forced

    func body(content: Content) -> some View {
        let barBottom = barBottom, forced = forced, ends = ends
        content.visualEffect { effect, proxy in
            effect.opacity(forced ?? BarFade.strength(midY: proxy.frame(in: .scrollView).midY, barBottom: barBottom, ends: ends))
        }
    }
}

private struct FadesIntoBar: ViewModifier {
    @Environment(\.barBottom) private var barBottom
    @Environment(\.barTitleStrength) private var bar
    @Environment(\.barFadeForced) private var forced
    @State private var last = Last()

    private final class Last {
        var midY: CGFloat?
    }

    func body(content: Content) -> some View {
        content
            .modifier(FadesUnderBar(ends: BarFade.titleEnds))
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .scrollView).midY } action: { midY in
                last.midY = midY
                report(midY)
            }
            .onChange(of: barBottom) { report(last.midY) }
            .onChange(of: bar.map(ObjectIdentifier.init)) { report(last.midY) }
    }

    private func report(_ midY: CGFloat?) {
        guard forced == nil, let midY else { return }
        bar?.set(BarFade.bar(BarFade.strength(midY: midY, barBottom: barBottom, ends: BarFade.titleEnds)))
    }
}

struct BarTitleLabel: View {
    let title: String
    let strength: BarTitleStrength?
    var forced: Double?
    @Environment(\.accessibilityReduceMotion) private var still

    var body: some View {
        let shown = forced ?? strength?.value ?? 0
        Text(title)
            .cockpit(.headline)
            .foregroundStyle(Cockpit.Color.text)
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(width: 232)
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            .titleHalo()
            .opacity(shown)
            .offset(y: still ? 0 : BarFade.rise * (1 - shown))
            .accessibilityHidden(shown < 1)
            .accessibilityIdentifier(shown < 1 ? "" : "bar.title")
            .transaction { $0.animation = nil }
    }
}

enum ScrollFade {
    static let length: CGFloat = Cockpit.Space.s8
    static let eased: [(at: CGFloat, strength: Double)] = [(8, 0.85), (16, 0.55), (24, 0.25)]

    @available(macOS 15, *)
    static func strength(_ geometry: ScrollGeometry) -> Double {
        min(1, max(0, Double((geometry.contentOffset.y + geometry.contentInsets.top) / length)))
    }

    struct Band: View {
        let ground: Color
        let under: Double

        var body: some View {
            LinearGradient(stops: [.init(color: ground.opacity(under), location: 0)]
                               + ScrollFade.eased.map { .init(color: ground.opacity($0.strength * under), location: $0.at / ScrollFade.length) }
                               + [.init(color: ground.opacity(0), location: 1)],
                           startPoint: .top, endPoint: .bottom)
                .frame(height: ScrollFade.length)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }
}
