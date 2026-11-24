import SwiftUI

public struct CheckDisc: View {
    let color: Color
    let size: CGFloat

    public init(_ color: Color = Cockpit.Color.textTertiary, size: CGFloat = Cockpit.Size.iconSm) {
        self.color = color
        self.size = size
    }

    public var body: some View {
        ZStack {
            Circle().fill(color).frame(width: size * 0.875, height: size * 0.875)
            CheckMark()
                .stroke(Cockpit.Color.canvas, style: StrokeStyle(lineWidth: size * 0.11, lineCap: .round, lineJoin: .round))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private struct CheckMark: Shape {
        func path(in rect: CGRect) -> Path {
            let unit = rect.width / 16
            var path = Path()
            path.move(to: CGPoint(x: 4.8 * unit, y: 8.3 * unit))
            path.addLine(to: CGPoint(x: 7 * unit, y: 10.5 * unit))
            path.addLine(to: CGPoint(x: 11.2 * unit, y: 5.9 * unit))
            return path
        }
    }
}

public struct StepMarks: View {
    public enum Mark: Sendable, Equatable {
        case done
        case here
        case past
        case ahead
    }

    let marks: [Mark]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.firstRunPull) private var pull

    public init(_ marks: [Mark]) {
        self.marks = marks
    }

    static let side: CGFloat = 14
    static let gap: CGFloat = 10

    private var here: Int? { marks.firstIndex(of: .here) }

    public var body: some View {
        HStack(spacing: Self.gap) {
            ForEach(Array(marks.enumerated()), id: \.offset) { _, mark in
                Self.still(mark).frame(width: Self.side, height: Self.side)
            }
        }
        .background { if marks.count > 1 { Self.thread } }
        .overlay(alignment: .leading) {
            if let here {
                HereDisc()
                    .offset(x: (CGFloat(here) - (here > 0 ? pull : 0)) * (Self.side + Self.gap))
                    .animation(reduceMotion ? nil : .timingCurve(0.45, 0, 0.25, 1, duration: Cockpit.Duration.base), value: here)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Setup steps")
        .accessibilityValue(spoken)
    }

    @ViewBuilder static func still(_ mark: Mark) -> some View {
        switch mark {
        case .done: Circle().fill(Cockpit.Color.textTertiary).frame(width: 8, height: 8)
        case .past, .ahead:
            Circle().fill(Cockpit.Color.strokeControl).frame(width: 6, height: 6)
        case .here: Color.clear
        }
    }

    static var thread: some View {
        let glacier = Cockpit.Onboarding.Color.glacier
        return LinearGradient(stops: [
            .init(color: glacier.opacity(0), location: 0),
            .init(color: glacier.opacity(0.4), location: 0.2),
            .init(color: glacier.opacity(0.4), location: 0.8),
            .init(color: glacier.opacity(0), location: 1),
        ], startPoint: .leading, endPoint: .trailing)
        .frame(height: 1)
        .accessibilityHidden(true)
    }

    private var spoken: String { Self.spoken(marks) }

    public static func spoken(_ marks: [Mark]) -> String {
        let skipped = marks.filter { $0 == .past }.count
        let step = marks.firstIndex(of: .here).map { "Step \($0 + 1) of \(marks.count)" } ?? "\(marks.count) steps"
        return skipped == 0 ? step : "\(step), \(skipped) skipped"
    }

    private struct HereDisc: View {
        var body: some View {
            ZStack {
                Circle().fill(Cockpit.Color.hereSoft)
                Circle().fill(Cockpit.Color.here).frame(width: 8, height: 8)
            }
            .frame(width: StepMarks.side, height: StepMarks.side)
        }
    }
}

private let firstRunFrame = "first-run-frame"

public struct FirstRunFrame<Marks: View, Column: View, Foot: View>: View {
    let scrolls: Bool
    let centred: Bool
    let grounded: Bool
    let band: Image?
    let back: FirstRunBack?
    let marks: Marks
    let column: Column
    let foot: Foot
    @State private var pulled: CGFloat = 0
    @State private var width: CGFloat = 0
    @State private var bandTop: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize

    public init(scrolls: Bool = true, centred: Bool = false, grounded: Bool = false, band: Image? = nil, back: FirstRunBack? = nil,
                @ViewBuilder marks: () -> Marks, @ViewBuilder column: () -> Column, @ViewBuilder foot: () -> Foot) {
        self.scrolls = scrolls
        self.centred = centred
        self.grounded = grounded
        self.band = band
        self.back = back
        self.marks = marks()
        self.column = column()
        self.foot = foot()
    }

    private var pull: CGFloat { width > 0 ? min(max(pulled / width, 0), 1) : 0 }

    private var drawnBand: Image? { typeSize.isAccessibilitySize ? nil : band ?? back?.band }

    private var bandShown: CGFloat {
        let open: CGFloat = band == nil ? 0 : 1
        let before: CGFloat = back?.band == nil ? 0 : 1
        return open + (before - open) * pull
    }

    private var clearance: CGFloat {
        guard band != nil, drawnBand != nil else { return 0 }
        let roomTop = Marks.self == EmptyView.self ? 0 : 15 + StepMarks.side + Cockpit.Space.s6
        return max(0, bandTop + RiverBand.height - roomTop)
    }

    public var body: some View {
        VStack(spacing: 0) {
            marks
                .frame(maxWidth: .infinity, minHeight: StepMarks.side, maxHeight: StepMarks.side)
                .padding(.top, 15)
                .padding(.bottom, Cockpit.Space.s6)
                .opacity(back?.marked == false ? 1 - pull : 1)
                .environment(\.firstRunPull, pull)
            ZStack(alignment: .top) {
                if let back, pulled > 0 {
                    room(back.previous, centred: back.centred, grounded: back.grounded, clear: 0)
                        .offset(x: -width * 0.3 * (1 - pull))
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
                room(column, centred: centred, grounded: grounded, clear: centred ? clearance : 0)
                    .background(pulled > 0 ? Cockpit.Color.canvas : .clear)
                    .shadow(color: .black.opacity(pulled > 0 ? 0.12 * (1 - pull) : 0), radius: 10, x: -2)
                    .offset(x: pulled)
            }
            .frame(maxHeight: .infinity)
            .clipped()
            .overlay(alignment: .leading) {
                if back != nil {
                    Color.clear.frame(width: 20).contentShape(Rectangle()).gesture(swipe)
                }
            }
            foot
                .padding(.horizontal, Cockpit.Gap.edge)
                .padding(.top, Cockpit.Space.s2)
                .padding(.bottom, Cockpit.Space.s3)
        }
        .background {
            ZStack(alignment: .top) {
                Cockpit.Color.canvas
                if let drawnBand {
                    RiverBand(drawnBand, height: grounded || back?.grounded == true ? RiverBand.tall : RiverBand.height)
                        .opacity(bandShown).transition(.opacity)
                }
            }
            .ignoresSafeArea()
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(firstRunFrame)).minY } action: { bandTop = $0 }
        }
        .coordinateSpace(.named(firstRunFrame))
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .accessibilityAction(.escape) {
            guard let back else { return }
            if reduceMotion { back.go() } else { slideOff(back) }
        }
    }

    private var swipe: some Gesture {
        DragGesture(minimumDistance: 8, coordinateSpace: .global)
            .onChanged { value in
                guard !reduceMotion else { return }
                pulled = max(0, value.translation.width)
            }
            .onEnded { value in
                guard let back else { return }
                let gone = value.translation.width > width / 3
                    || (value.predictedEndTranslation.width > width / 2 && value.translation.width > 0)
                if reduceMotion {
                    if gone { back.go() }
                    return
                }
                guard gone else {
                    withAnimation(.spring(duration: Cockpit.Duration.base, bounce: 0)) { pulled = 0 }
                    return
                }
                slideOff(back)
            }
    }

    private func slideOff(_ back: FirstRunBack) {
        withAnimation(.easeOut(duration: Cockpit.Duration.base)) {
            pulled = width
        } completion: {
            var still = Transaction()
            still.disablesAnimations = true
            withTransaction(still) {
                back.go()
                pulled = 0
            }
        }
    }

    @ViewBuilder private func room(_ content: some View, centred: Bool, grounded: Bool, clear: CGFloat) -> some View {
        if scrolls, grounded {
            GeometryReader { room in
                scroller(placed(content).frame(minHeight: room.size.height, alignment: .bottom))
            }
        } else if scrolls, centred {
            GeometryReader { room in
                scroller(placed(content).frame(minHeight: max(0, room.size.height - clear)).padding(.top, clear))
            }
        } else if scrolls {
            scroller(placed(content).padding(.top, clear))
        } else {
            placed(content).frame(maxHeight: .infinity, alignment: centred ? .center : .top).padding(.top, clear)
        }
    }

    private func scroller(_ content: some View) -> some View {
        ScrollView { content }
            .scrollBounceBehavior(.basedOnSize)
            .scrollDismissesKeyboard(.interactively)
    }

    private func placed(_ content: some View) -> some View {
        content
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .padding(.horizontal, Cockpit.Gap.edge)
            .padding(.bottom, Cockpit.Space.s6)
    }
}

public extension FirstRunFrame where Marks == EmptyView {
    init(scrolls: Bool = true, centred: Bool = false, grounded: Bool = false, band: Image? = nil, back: FirstRunBack? = nil,
         @ViewBuilder column: () -> Column, @ViewBuilder foot: () -> Foot) {
        self.init(scrolls: scrolls, centred: centred, band: band, back: back, marks: { EmptyView() }, column: column, foot: foot)
    }
}

public struct FirstRunBack {
    let previous: AnyView
    let centred: Bool
    let grounded: Bool
    let marked: Bool
    let band: Image?
    let go: () -> Void

    public init(centred: Bool = false, grounded: Bool = false, marked: Bool = true, band: Image? = nil, go: @escaping () -> Void,
                @ViewBuilder previous: () -> some View) {
        self.previous = AnyView(previous())
        self.centred = centred
        self.grounded = grounded
        self.marked = marked
        self.band = band
        self.go = go
    }
}

public struct RiverBand: View {
    public static let height: CGFloat = 180
    public static let tall: CGFloat = 480
    private static let fade: CGFloat = 160
    private static let shade = 0.9
    let image: Image
    let height: CGFloat

    public init(_ image: Image, height: CGFloat = RiverBand.height) {
        self.image = image
        self.height = height
    }

    public var body: some View {
        let ground = Cockpit.Color.canvas
        let fade = min(Self.fade / height, 0.55)
        Color.clear
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .overlay { image.resizable().scaledToFill() }
            .clipped()
            .overlay {
                LinearGradient(stops: [
                    .init(color: ground.opacity(Self.shade), location: 0),
                    .init(color: ground.opacity(0), location: 72 / height),
                    .init(color: ground.opacity(0), location: 1 - fade),
                    .init(color: ground.opacity(0.35), location: 1 - fade * 0.64),
                    .init(color: ground.opacity(0.8), location: 1 - fade * 0.27),
                    .init(color: ground, location: 1),
                ], startPoint: .top, endPoint: .bottom)
            }
            .accessibilityHidden(true)
    }
}

extension EnvironmentValues {
    @Entry var firstRunPull: CGFloat = 0
}

public struct FirstRunColumn<Picture: View, Line: View, Below: View>: View {
    public func onAxis() -> Self {
        var column = self
        column.centred = true
        return column
    }

    let title: String
    let pictureShown: Bool
    let picture: Picture
    let line: Line
    let below: Below
    var centred = false
    @Environment(\.dynamicTypeSize) private var typeSize

    public init(_ title: String, pictureShown: Bool = true, @ViewBuilder picture: () -> Picture, @ViewBuilder line: () -> Line,
                @ViewBuilder below: () -> Below) {
        self.title = title
        self.pictureShown = pictureShown
        self.picture = picture()
        self.line = line()
        self.below = below()
    }

    public static func pictureHeight(_ size: DynamicTypeSize) -> CGFloat { size.isAccessibilitySize ? 160 : 220 }

    public var body: some View {
        VStack(alignment: centred ? .center : .leading, spacing: 0) {
            if Picture.self != EmptyView.self {
                picture
                    .frame(maxWidth: .infinity)
                    .frame(height: pictureShown ? Self.pictureHeight(typeSize) : 0)
                    .opacity(pictureShown ? 1 : 0)
                    .clipped()
                    .padding(.bottom, pictureShown ? Cockpit.Space.s6 : 0)
                    .animation(.easeOut(duration: Cockpit.Duration.base), value: pictureShown)
            }
            Text(title)
                .cockpit(.title1)
                .foregroundStyle(Cockpit.Color.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .contentTransition(.opacity)
                .multilineTextAlignment(centred ? .center : .leading)
            if Line.self != EmptyView.self {
                line.padding(.top, Cockpit.Space.s2).multilineTextAlignment(centred ? .center : .leading)
            }
            if Below.self != EmptyView.self {
                below.padding(.top, Cockpit.Space.s6)
            }
        }
    }
}

public extension FirstRunColumn where Below == EmptyView {
    init(_ title: String, pictureShown: Bool = true, @ViewBuilder picture: () -> Picture, @ViewBuilder line: () -> Line) {
        self.init(title, pictureShown: pictureShown, picture: picture, line: line, below: { EmptyView() })
    }
}

public struct FirstRunLine: View {
    public enum Kind: Sendable, Equatable { case words, found, state }

    let words: String
    let kind: Kind
    @State private var filled = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var lift: CGFloat = 6

    public init(_ words: String, kind: Kind = .words) {
        self.words = words
        self.kind = kind
    }

    public var body: some View {
        let lift = self.lift
        HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s2) {
            switch kind {
            case .words:
                EmptyView()
            case .found:
                CheckDisc(Cockpit.Color.engaged)
                    .scaleEffect(filled || reduceMotion ? 1 : 0.6)
                    .opacity(filled ? 1 : 0)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + lift }
                    .onAppear {
                        withAnimation(reduceMotion ? nil : .easeOut(duration: Cockpit.Duration.fast).delay(Cockpit.Duration.stagger)) {
                            filled = true
                        }
                    }
            case .state:
                Circle()
                    .strokeBorder(Cockpit.Color.strokeControl, lineWidth: 1.5)
                    .frame(width: 12, height: 12)
                    .frame(width: Cockpit.Size.iconSm, height: Cockpit.Size.iconSm)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + lift }
                    .accessibilityHidden(true)
            }
            Text(words)
                .cockpit(.body)
                .foregroundStyle(kind == .words ? Cockpit.Color.textSecondary : Cockpit.Color.text)
                .fixedSize(horizontal: false, vertical: true)
                .contentTransition(.opacity)
        }
        .animation(.easeOut(duration: Cockpit.Duration.fast), value: words)
        .accessibilityElement(children: .combine)
    }
}

public struct FirstRunFoot<Primary: View, Plain: View>: View {
    let note: String?
    let done: String?
    let primary: Primary
    let plain: Plain

    public init(note: String? = nil, done: String? = nil, @ViewBuilder primary: () -> Primary, @ViewBuilder plain: () -> Plain) {
        self.note = note
        self.done = done
        self.primary = primary()
        self.plain = plain()
    }

    public var body: some View {
        VStack(spacing: Cockpit.Space.s2) {
            if let note {
                Text(note)
                    .cockpit(.footnote)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, Cockpit.Space.s2)
                    .transition(.opacity)
                    .accessibilityIdentifier("firstrun.note")
            }
            primary.environment(\.cockpitDone, done)
            Color.clear.frame(maxWidth: .infinity).frame(height: Cockpit.Size.controlMd).overlay {
                if done == nil { plain.transition(.opacity) }
            }
        }
        .animation(.easeOut(duration: Cockpit.Duration.fast), value: note)
        .animation(.easeOut(duration: Cockpit.Duration.fast), value: done)
    }
}

public extension FirstRunFoot where Plain == EmptyView {
    init(note: String? = nil, done: String? = nil, @ViewBuilder primary: () -> Primary) {
        self.init(note: note, done: done, primary: primary, plain: { EmptyView() })
    }
}

public struct LogoMark: View {
    let side: CGFloat

    public init(side: CGFloat = Cockpit.Space.s16) {
        self.side = side
    }

    public static func glyph(in rect: CGRect) -> Path {
        Streams(points: LoadingMark.still).path(in: rect)
            .intersection(RoundedRectangle(cornerRadius: rect.width * LoadingMark.tileRadius, style: .continuous).path(in: rect))
    }

    public var body: some View {
        let tile = RoundedRectangle(cornerRadius: side * LoadingMark.tileRadius, style: .continuous)
        Streams(points: LoadingMark.still)
            .fill(Cockpit.Color.text)
            .background(Cockpit.Color.raised)
            .clipShape(tile)
            .frame(width: side, height: side)
            .accessibilityHidden(true)
    }
}

public struct PairPicture: View {
    let joined: Bool

    public init(joined: Bool) {
        self.joined = joined
    }

    public var body: some View {
        HStack(spacing: Cockpit.Space.s5) {
            IconShape(meaning: .workMac).fill(Cockpit.Color.textSecondary).frame(width: 44, height: 44)
            Group {
                if joined {
                    Capsule().fill(Cockpit.Color.strokeControl).frame(width: 48, height: 1.5)
                } else {
                    Line()
                        .stroke(Cockpit.Color.strokeControl, style: StrokeStyle(lineWidth: 1.5, dash: [3, 3]))
                        .frame(width: 48, height: 1.5)
                }
            }
            .animation(.easeOut(duration: Cockpit.Duration.fast), value: joined)
            IconShape(meaning: .phoneScreen).fill(Cockpit.Color.textSecondary).frame(width: 44, height: 44)
        }
        .accessibilityHidden(true)
    }

    private struct Line: Shape {
        func path(in rect: CGRect) -> Path {
            var path = Path()
            path.move(to: CGPoint(x: rect.minX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
            return path
        }
    }
}

public struct MacStepPicture: View {
    public init() {}

    public var body: some View {
        GeometryReader { proxy in
            let scale = min(1, proxy.size.width / 300, proxy.size.height / 190)
            drawing
                .scaleEffect(scale)
                .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .frame(idealWidth: 300, maxWidth: 300, idealHeight: 190, maxHeight: 190)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityHidden(true)
    }

    private var drawing: some View {
        let window = RoundedRectangle(cornerRadius: Cockpit.Radius.sm + 4, style: .continuous)
        return ZStack(alignment: .topLeading) {
            HStack(spacing: 5) {
                ForEach(0..<3, id: \.self) { _ in Circle().fill(Cockpit.Color.data4).frame(width: 7, height: 7) }
            }
            .padding(12)
            VStack(alignment: .leading, spacing: 6) {
                Capsule().fill(Cockpit.Color.data4).frame(width: 150, height: 9)
                Capsule().fill(Cockpit.Color.track).frame(width: 200, height: 6)
                HStack(alignment: .top, spacing: Cockpit.Space.s3) {
                    CodeDrawing()
                        .padding(6)
                        .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Cockpit.Color.codeGround))
                        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Cockpit.Color.rule, lineWidth: Cockpit.Stroke.border))
                        .frame(width: 92, height: 92)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Or type")
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(Cockpit.Color.textSecondary)
                        Capsule().fill(Cockpit.Color.data4).frame(width: 84, height: 8)
                    }
                    .padding(.top, Cockpit.Space.s4)
                }
                .padding(.top, Cockpit.Space.s2)
            }
            .padding(.leading, Cockpit.Space.s6)
            .padding(.top, 40)
        }
        .frame(width: 300, height: 190, alignment: .topLeading)
        .background(window.fill(Cockpit.Color.surface))
        .cockpitShadow(Cockpit.Shadow.edge, in: window)
    }

    private struct CodeDrawing: View {
        var body: some View {
            Canvas { context, size in
                let n = 21
                let m = size.width / CGFloat(n)
                var seed: UInt32 = 7
                func next() -> Bool {
                    seed = seed &* 1_103_515_245 &+ 12_345
                    return (seed >> 16) & 1 == 1
                }
                let ink = GraphicsContext.Shading.color(Cockpit.Color.code)
                let ground = GraphicsContext.Shading.color(Cockpit.Color.codeGround)
                func square(_ x: Int, _ y: Int, _ side: Int, _ shading: GraphicsContext.Shading) {
                    context.fill(Path(CGRect(x: CGFloat(x) * m, y: CGFloat(y) * m, width: CGFloat(side) * m, height: CGFloat(side) * m)),
                                 with: shading)
                }
                for y in 0..<n {
                    for x in 0..<n {
                        let finder = (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9)
                        if !finder && next() { square(x, y, 1, ink) }
                    }
                }
                for (x, y) in [(0, 0), (n - 7, 0), (0, n - 7)] {
                    square(x, y, 7, ink)
                    square(x + 1, y + 1, 5, ground)
                    square(x + 2, y + 2, 3, ink)
                }
            }
        }
    }
}
