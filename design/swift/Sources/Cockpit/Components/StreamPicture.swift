import SwiftUI

public struct StreamPicture: View {
    public enum Kind {
        case map(place: AnyView? = nil, off: Bool = false)
        case motion
        case health
        case screenTime
        case photos([Image]? = nil, limited: Bool = false)
        case contacts([String]? = nil)
    }

    let kind: Kind

    public init(_ kind: Kind) {
        self.kind = kind
    }

    public var body: some View {
        Group {
            switch kind {
            case let .map(place, off): MapPicture(place: place, off: off)
            case .motion:
                LinePicture(rules: 4,
                            marks: [.stretch(0.08, 0.32, .walk), .stretch(0.44, 0.25, .drive), .stretch(0.72, 0.16, .place)])
            case .health:
                LinePicture(rules: 4,
                            marks: [.stretch(0.07, 0.51, .sleep), .stretch(0.63, 0.16, .steps), .moment(0.86, .health)])
            case .screenTime:
                LinePicture(rules: 4,
                            marks: [.stretch(0.08, 0.14, .phoneScreen), .stretch(0.38, 0.22, .phoneScreen), .stretch(0.74, 0.1, .phoneScreen)])
            case let .photos(pictures, limited): PhotosPicture(pictures: pictures, limited: limited)
            case let .contacts(initials): ChipsPicture(initials: initials)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct MapPicture: View {
    let place: AnyView?
    let off: Bool

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous)
        ZStack {
            if let place {
                place
                    .overlay { HereMark() }
                    .transition(.opacity)
            } else {
                Canvas { context, size in
                    context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Cockpit.Color.mapLand))
                    let (w, h) = (size.width, size.height)
                    var major = Path()
                    major.move(to: CGPoint(x: -10, y: h * 0.3))
                    major.addCurve(to: CGPoint(x: w + 10, y: h * 0.3), control1: CGPoint(x: w * 0.35, y: h * 0.1), control2: CGPoint(x: w * 0.65, y: h * 0.5))
                    major.move(to: CGPoint(x: w * 0.17, y: -10))
                    major.addCurve(to: CGPoint(x: w * 0.26, y: h + 10), control1: CGPoint(x: w * 0.2, y: h * 0.3), control2: CGPoint(x: w * 0.14, y: h * 0.6))
                    major.move(to: CGPoint(x: w * 0.58, y: -10))
                    major.addCurve(to: CGPoint(x: w * 0.61, y: h + 10), control1: CGPoint(x: w * 0.55, y: h * 0.35), control2: CGPoint(x: w * 0.67, y: h * 0.65))
                    major.move(to: CGPoint(x: -10, y: h * 0.75))
                    major.addCurve(to: CGPoint(x: w + 10, y: h * 0.65), control1: CGPoint(x: w * 0.3, y: h * 0.7), control2: CGPoint(x: w * 0.5, y: h * 0.85))
                    context.stroke(major, with: .color(Cockpit.Color.mapRoadMajor), style: StrokeStyle(lineWidth: 6, lineCap: .round))
                    var minor = Path()
                    minor.move(to: CGPoint(x: -10, y: h * 0.5))
                    minor.addLine(to: CGPoint(x: w + 10, y: h * 0.5))
                    minor.move(to: CGPoint(x: w * 0.4, y: -10))
                    minor.addLine(to: CGPoint(x: w * 0.4, y: h + 10))
                    minor.move(to: CGPoint(x: w * 0.84, y: -10))
                    minor.addLine(to: CGPoint(x: w * 0.84, y: h + 10))
                    context.stroke(minor, with: .color(Cockpit.Color.mapRoadMinor), lineWidth: 2.5)
                    guard !off else { return }
                    let from = CGPoint(x: w * 0.23, y: h * 0.64), to = CGPoint(x: w * 0.61, y: h * 0.36)
                    var journey = Path()
                    journey.move(to: from)
                    journey.addCurve(to: to, control1: CGPoint(x: w * 0.35, y: h * 0.55), control2: CGPoint(x: w * 0.43, y: h * 0.3))
                    context.stroke(journey, with: .color(Cockpit.Color.life), style: StrokeStyle(lineWidth: 3, lineCap: .round))
                }
                .overlay {
                    if !off {
                        GeometryReader { proxy in
                            let disc = MapMarks.diameter(hours: 30)
                            PlaceDisc(diameter: disc).position(x: proxy.size.width * 0.23, y: proxy.size.height * 0.64)
                            PlaceDisc(diameter: disc).position(x: proxy.size.width * 0.61, y: proxy.size.height * 0.36)
                        }
                    }
                }
                .opacity(off ? 0.6 : 1)
                .transition(.opacity)
            }
        }
        .clipShape(shape)
        .overlay(shape.strokeBorder(Cockpit.Color.rule, lineWidth: Cockpit.Stroke.border))
        .animation(.easeOut(duration: Cockpit.Duration.fast), value: place == nil)
    }
}

private struct LinePicture: View {
    enum Mark {
        case stretch(Double, Double, Cockpit.Icon)
        case moment(Double, Cockpit.Icon)
    }

    let rules: Int
    let marks: [Mark]

    var body: some View {
        GeometryReader { proxy in
            let h = proxy.size.height
            let time: CGFloat = 48
            let rail = Cockpit.Size.capsule
            let centre = time + rail / 2
            ZStack(alignment: .topLeading) {
                ForEach(0..<rules, id: \.self) { index in
                    let y = (CGFloat(index) / CGFloat(max(1, rules - 1))) * (h - 16) + 8
                    HStack(spacing: Cockpit.Space.s2) {
                        Capsule()
                            .fill(Cockpit.Color.strokeControl)
                            .frame(width: 14, height: 2)
                            .frame(width: time - Cockpit.Space.s2, alignment: .leading)
                        Rectangle().fill(Cockpit.Color.rule).frame(height: Cockpit.Stroke.border)
                    }
                    .frame(height: 16)
                    .offset(y: y - 8)
                }
                Capsule()
                    .fill(Cockpit.Color.life)
                    .frame(width: Cockpit.Stroke.line, height: h - 24)
                    .offset(x: centre - Cockpit.Stroke.line / 2, y: 12)
                ForEach(Array(marks.enumerated()), id: \.offset) { _, mark in
                    switch mark {
                    case let .stretch(top, length, icon):
                        Capsule()
                            .fill(Cockpit.Color.life)
                            .overlay { Icon(icon, size: .sm).foregroundStyle(Cockpit.Color.lifeGlyph) }
                            .frame(width: rail, height: max(rail, h * length))
                            .offset(x: time, y: h * top)
                    case let .moment(top, icon):
                        Circle()
                            .fill(Cockpit.Color.canvas)
                            .overlay(Circle().strokeBorder(Cockpit.Color.life, lineWidth: Cockpit.Stroke.line))
                            .overlay { Icon(icon, size: .xs).foregroundStyle(Cockpit.Color.text) }
                            .frame(width: Cockpit.Size.moment, height: Cockpit.Size.moment)
                            .offset(x: centre - Cockpit.Size.moment / 2, y: h * top)
                    }
                }
            }
        }
    }
}

private struct PhotosPicture: View {
    let pictures: [Image]?
    let limited: Bool

    private struct Tile: Identifiable {
        let id: Int
        let picture: Image?
    }

    var body: some View {
        let tiles = (0..<8).map { index in Tile(id: index, picture: pictures.flatMap { index < $0.count ? $0[index] : nil }) }
        PhotoGrid(tiles, columns: 4, label: { _ in "" }, open: { _ in }) { tile in
            if let picture = tile.picture {
                picture.resizable().scaledToFill().transition(.opacity)
            } else {
                Color.clear
            }
        }
        .modifier(Shown(limited: limited, count: pictures?.count))
        .frame(maxHeight: .infinity, alignment: .center)
        .animation(.easeOut(duration: Cockpit.Duration.fast), value: pictures?.count)
    }

    private struct Shown: ViewModifier {
        let limited: Bool
        let count: Int?
        func body(content: Content) -> some View {
            content.mask {
                GeometryReader { proxy in
                    let gap = Cockpit.Space.s2
                    let side = (proxy.size.width - 3 * gap) / 4
                    let standing = limited ? (count ?? 8) : 8
                    ZStack(alignment: .topLeading) {
                        ForEach(0..<min(8, standing), id: \.self) { index in
                            Rectangle()
                                .frame(width: side, height: side)
                                .offset(x: CGFloat(index % 4) * (side + gap), y: CGFloat(index / 4) * (side + gap))
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
            }
        }
    }
}

private struct ChipsPicture: View {
    let initials: [String]?

    var body: some View {
        VStack(spacing: Cockpit.Space.s3) {
            HStack(spacing: Cockpit.Space.s3) { ForEach(0..<3, id: \.self) { chip($0) } }
            HStack(spacing: Cockpit.Space.s3) { ForEach(3..<5, id: \.self) { chip($0) } }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.easeOut(duration: Cockpit.Duration.fast), value: initials)
    }

    private func chip(_ index: Int) -> some View {
        let letter = initials.flatMap { $0.indices.contains(index) ? $0[index] : nil }
        return HStack(spacing: Cockpit.Space.s2) {
            Monogram(letter, size: .sm)
            Capsule()
                .fill(initials == nil ? Cockpit.Color.track : Cockpit.Color.data4)
                .frame(width: CGFloat(36 + index * 8), height: 8)
        }
        .padding(.leading, 6)
        .padding(.trailing, Cockpit.Space.s4)
        .frame(height: 36)
        .overlay(Capsule().strokeBorder(Cockpit.Color.border, lineWidth: Cockpit.Stroke.border))
    }
}
