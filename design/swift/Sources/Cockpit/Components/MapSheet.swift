import SwiftUI

public struct MapSheet<Title: View, Head: View, Content: View>: View {
    public typealias Rest = SheetRest

    @Binding var rest: Rest
    let page: AnyHashable
    let bar: CGFloat?
    let onCover: ((CGFloat) -> Void)?
    let title: Title
    let head: Head
    let content: Content
    @GestureState(resetTransaction: Transaction(animation: .smooth(duration: Cockpit.Duration.slow))) private var drag: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.cockpitPlatform) private var platform
    @State private var titleHeight: CGFloat = 44

    private var inset: CGFloat { rest != .high ? side : 0 }
    private var side: CGFloat { platform == .ios ? Cockpit.Space.s2 : 0 }
    private var corner: CGFloat { platform == .ios ? Cockpit.sheetCorner : Cockpit.Radius.s2xl }

    public init(rest: Binding<Rest>, page: AnyHashable, bar: CGFloat? = nil, onCover: ((CGFloat) -> Void)? = nil,
                @ViewBuilder title: () -> Title, @ViewBuilder head: () -> Head, @ViewBuilder content: () -> Content) {
        self._rest = rest
        self.page = page
        self.bar = bar
        self.onCover = onCover
        self.title = title()
        self.head = head()
        self.content = content()
    }

    public var body: some View {
        GeometryReader { geometry in
            let height = geometry.size.height
            let foot = bar ?? geometry.safeAreaInsets.bottom
            let tops = Tops(height: height, foot: foot, title: titleHeight)
            let top = tops.y(rest, drag: drag)
            let lowered = top >= tops.low - 1
            let width = geometry.size.width
            let shape = SheetShape(corner: corner, side: inset)
            let margin = Cockpit.Gap.sheet - inset
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    grabber
                    title
                        .padding(.horizontal, margin)
                        .padding(.top, Cockpit.Space.s1)
                        .padding(.bottom, Cockpit.Space.s3)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { titleHeight = $0 }
                    head
                        .padding(.horizontal, margin)
                        .padding(.bottom, Cockpit.Gap.head)
                        .opacity(lowered ? 0 : 1)
                        .allowsHitTesting(!lowered)
                }
                .frame(width: width - inset * 2)
                .contentShape(Rectangle())
                .highPriorityGesture(dragging(tops))
                list(tops, foot: foot)
                    .frame(width: width - side * 2)
            }
            .frame(width: width, height: height - tops.high + tops.give, alignment: .top)
            .frame(height: max(0, height - top), alignment: .top)
            .overlay(alignment: .bottom) {
                let fade = rest == .low ? 0 : Self.fade
                LinearGradient(stops: [.init(color: Cockpit.Color.surface.opacity(0), location: 0),
                                       .init(color: Cockpit.Color.surface, location: fade / max(foot + fade, 1)),
                                       .init(color: Cockpit.Color.surface, location: 1)],
                               startPoint: .top, endPoint: .bottom)
                    .frame(height: foot + fade)
                    .allowsHitTesting(false)
            }
            .background(shape.fill(Cockpit.Color.surface))
            .clipShape(shape)
            .overlay { if inset > 0 { shape.strokeBorder(Cockpit.Color.hairline, lineWidth: Cockpit.pixelRule).allowsHitTesting(false) } }
            .modifier(MapSheetShadow(shape: shape, on: platform != .ios))
            .offset(y: top)
            .transaction { if reduceMotion { $0.animation = nil } }
            .animation(reduceMotion ? nil : .smooth(duration: Cockpit.Duration.slow), value: rest)
            .onChange(of: tops.covers(rest), initial: true) { _, covered in onCover?(covered) }
            .frame(width: width, height: height, alignment: .top)
            .mask(alignment: .top) {
                UnevenRoundedRectangle(bottomLeadingRadius: inset > 0 ? Self.footCorner : 0, bottomTrailingRadius: inset > 0 ? Self.footCorner : 0, style: .continuous)
                    .padding(.bottom, inset)
                    .padding(.top, -height)
            }
        }
    }

    private static var footCorner: CGFloat { 60 }

    private static var fade: CGFloat { Cockpit.Space.s8 }

    private func list(_ tops: Tops, foot: CGFloat) -> some View {
        ScrollView {
            content
                .padding(.horizontal, Cockpit.Gap.sheet - side)
                .padding(.bottom, foot + Cockpit.Space.s6)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentMargins(.bottom, tops.under(rest))
        .id(page)
        .scrollDismissesKeyboard(.immediately)
    }

    private var grabber: some View {
        Capsule()
            .fill(Cockpit.Color.strokeControl)
            .frame(width: 36, height: 5)
            .frame(maxWidth: .infinity)
            .frame(height: Tops.grabber, alignment: .bottom)
            .accessibilityElement()
            .accessibilityIdentifier("sheet.grabber")
            .accessibilityLabel("Sheet")
            .accessibilityValue(rest.word)
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: rest = Rest(rawValue: min(rest.rawValue + 1, Rest.high.rawValue)) ?? rest
                case .decrement: rest = Rest(rawValue: max(rest.rawValue - 1, Rest.low.rawValue)) ?? rest
                @unknown default: break
                }
            }
    }

    private func dragging(_ tops: Tops) -> some Gesture {
        DragGesture(minimumDistance: 8, coordinateSpace: .global)
            .updating($drag) { value, state, _ in
                guard abs(value.translation.height) > abs(value.translation.width) else { return }
                state = value.translation.height
            }
            .onEnded { value in
                guard abs(value.translation.height) > abs(value.translation.width) else { return }
                let from = tops.y(rest, drag: 0)
                let headed = from + value.predictedEndTranslation.height
                rest = Rest.allCases.min { abs(tops.y($0, drag: 0) - headed) < abs(tops.y($1, drag: 0) - headed) } ?? rest
            }
    }
}

private struct MapSheetShadow<S: InsettableShape>: ViewModifier {
    let shape: S
    let on: Bool

    func body(content: Content) -> some View {
        if on { content.cockpitShadow(Cockpit.Shadow.float, in: shape) } else { content }
    }
}

private struct SheetShape: InsettableShape {
    let corner: CGFloat
    var side: CGFloat
    var inset: CGFloat = 0

    var animatableData: CGFloat {
        get { side }
        set { side = newValue }
    }

    func path(in rect: CGRect) -> Path {
        UnevenRoundedRectangle(topLeadingRadius: corner, topTrailingRadius: corner, style: .continuous)
            .inset(by: inset)
            .path(in: rect.insetBy(dx: side, dy: 0))
    }

    func inset(by amount: CGFloat) -> SheetShape {
        var shape = self
        shape.inset += amount
        return shape
    }
}

public enum SheetRest: Int, CaseIterable, Sendable {
    case low, middle, high

    var word: String {
        switch self {
        case .low: "Lowered"
        case .middle: "Halfway"
        case .high: "Raised"
        }
    }
}

private struct Tops {
    static let middle: CGFloat = 0.47
    static let grabber: CGFloat = 13

    let height: CGFloat
    let foot: CGFloat
    let title: CGFloat

    var high: CGFloat { Cockpit.Space.s2 }
    var middle: CGFloat { (height * Self.middle).rounded() }
    var low: CGFloat { max(middle + Cockpit.Space.s8, height - foot - Self.grabber - title) }
    var give: CGFloat { height / 3 }

    func y(_ rest: SheetRest, drag: CGFloat) -> CGFloat {
        let base: CGFloat = switch rest {
        case .low: low
        case .middle: middle
        case .high: high
        }
        let moved = base + drag
        if moved < high { return high - min((high - moved) / 3, give) }
        if moved > low { return low + (moved - low) / 3 }
        return moved
    }

    func under(_ rest: SheetRest) -> CGFloat {
        (rest == .high ? 0 : middle - high) + give
    }

    func covers(_ rest: SheetRest) -> CGFloat {
        height - y(rest, drag: 0)
    }
}
