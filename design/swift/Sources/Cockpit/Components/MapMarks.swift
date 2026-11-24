import SwiftUI

public struct PlaceDisc: View {
    let diameter: CGFloat
    let faded: Bool
    let lit: Bool

    public init(diameter: CGFloat, faded: Bool = false, lit: Bool = false) {
        self.diameter = diameter
        self.faded = faded
        self.lit = lit
    }

    public var body: some View {
        ZStack {
            if lit {
                Circle()
                    .fill(Cockpit.Color.here.opacity(0.22))
                    .frame(width: diameter * 2, height: diameter * 2)
            }
            Circle()
                .fill(lit ? Cockpit.Color.here : MapMarks.ink)
                .overlay(Circle().strokeBorder(lit ? Cockpit.Color.canvas : Cockpit.Color.surface, lineWidth: MapMarks.edge))
                .frame(width: diameter, height: diameter)
        }
        .opacity(faded && !lit ? MapMarks.faded : 1)
    }
}

public enum MapMarks {
    public static var ink: Color {
        #if os(iOS)
        Cockpit.Color.here
        #else
        Cockpit.Color.life
        #endif
    }
    public static let disc: CGFloat = 12
    static var glyph: Color {
        #if os(iOS)
        Color.white
        #else
        Cockpit.Color.lifeGlyph
        #endif
    }
    public static let edge: CGFloat = 1.5
    public static let faded: Double = 0.45

    public static func short(_ name: String) -> String {
        guard name.count > 24 else { return name }
        let head = name.prefix(23)
        let cut = head.lastIndex(of: " ").map { head[..<$0] } ?? head
        return cut.trimmingCharacters(in: .whitespaces.union(.punctuationCharacters).union(CharacterSet(charactersIn: "|@-"))) + "…"
    }

    public static func diameter(hours: Double) -> CGFloat {
        min(34, 10 + 6 * log10(1 + max(0, hours)))
    }

    public static func diameter(places: Int) -> CGFloat {
        min(48, 12 + 6 * sqrt(Double(max(1, places))))
    }

    public static let ring: CGFloat = 14
    public static let openRing: CGFloat = 18
    public static let openCentre: CGFloat = 5
    public static let nameGap: CGFloat = 3
    public static let legend: CGFloat = 10
    public static let stay: CGFloat = 6
    public static let here: CGFloat = 11
    public static let halo: CGFloat = 22
}

public struct SpotRing: View {
    let diameter: CGFloat
    let open: Bool
    let lit: Bool

    public init(diameter: CGFloat? = nil, open: Bool = false, lit: Bool = false) {
        self.diameter = diameter ?? (open ? MapMarks.openRing : MapMarks.ring)
        self.open = open
        self.lit = lit
    }

    public var body: some View {
        Circle()
            .fill(Cockpit.Color.surface)
            .overlay(Circle().strokeBorder(lit ? Cockpit.Color.here : open ? MapMarks.ink : Cockpit.Color.textSecondary,
                                           lineWidth: lit ? MapMarks.edge + 0.5 : MapMarks.edge))
            .overlay {
                if open { Circle().fill(MapMarks.ink).frame(width: MapMarks.openCentre, height: MapMarks.openCentre) }
            }
            .frame(width: diameter, height: diameter)
    }
}

public struct StayDot: View {
    let lit: Bool

    public init(lit: Bool = false) {
        self.lit = lit
    }

    public var body: some View {
        Circle()
            .fill(lit ? Cockpit.Color.here : Cockpit.Color.textTertiary)
            .overlay(Circle().strokeBorder(Cockpit.Color.surface, lineWidth: 1))
            .frame(width: MapMarks.stay, height: MapMarks.stay)
    }
}

public struct HereMark: View {
    public init() {}

    public var body: some View {
        ZStack {
            Circle()
                .fill(Cockpit.Color.here.opacity(0.28))
                .frame(width: MapMarks.halo, height: MapMarks.halo)
            Circle()
                .fill(Cockpit.Color.here)
                .overlay(Circle().strokeBorder(Cockpit.Color.canvas, lineWidth: 2))
                .frame(width: MapMarks.here, height: MapMarks.here)
        }
    }
}

public struct ClusterDisc: View {
    let count: Int

    public init(count: Int) {
        self.count = count
    }

    public var body: some View {
        let side = MapMarks.diameter(places: count)
        PlaceDisc(diameter: side)
            .overlay {
                Text(count.formatted(.number.grouping(.automatic).locale(Locale(identifier: "en_US"))))
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .monospacedDigit()
                    .foregroundStyle(MapMarks.glyph)
                    .minimumScaleFactor(0.6)
                    .padding(3)
            }
    }
}

public struct MapName: View {
    let name: String
    let faded: Bool
    let strong: Bool

    public init(_ name: String, faded: Bool = false, strong: Bool = false) {
        self.name = name
        self.faded = faded
        self.strong = strong
    }

    public var body: some View {
        #if os(iOS)
        Text(MapMarks.short(name))
            .font(.system(size: 13, weight: strong ? .semibold : .regular))
            .foregroundStyle(Cockpit.Color.text)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, Cockpit.Space.s2)
            .padding(.vertical, 2)
            .background { Capsule().fill(Cockpit.Color.raised) }
            .opacity(faded ? MapMarks.faded : 1)
        #else
        Text(name)
            .font(.system(size: 11, weight: strong ? .semibold : .medium))
            .foregroundStyle(strong ? Cockpit.Color.text : Cockpit.Color.textSecondary)
            .lineLimit(1)
            .fixedSize()
            .mapHalo()
            .opacity(faded ? MapMarks.faded : 1)
        #endif
    }
}

extension View {
    func mapHalo() -> some View {
        let halo = MapGround.land
        return shadow(color: halo, radius: 0, x: 1, y: 0)
            .shadow(color: halo, radius: 0, x: -1, y: 0)
            .shadow(color: halo, radius: 0, x: 0, y: 1)
            .shadow(color: halo, radius: 0, x: 0, y: -1)
            .shadow(color: halo, radius: 1.5)
    }
}

public struct ReachCircle: View {
    public static let fill = Cockpit.Color.surface.opacity(0.55)
    public static let edge = Cockpit.Color.life
    public static let edgeWidth = Cockpit.Stroke.line
    public static let quietEdge = Cockpit.Color.textSecondary

    let diameter: CGFloat
    let quiet: Bool

    public init(diameter: CGFloat, quiet: Bool = false) {
        self.diameter = diameter
        self.quiet = quiet
    }

    public var body: some View {
        Circle()
            .fill(quiet ? Color.clear : Self.fill)
            .overlay(Circle().strokeBorder(quiet ? Self.quietEdge : Self.edge,
                                           style: quiet ? StrokeStyle(lineWidth: Cockpit.Stroke.border, dash: Cockpit.Dash.plan)
                                               : StrokeStyle(lineWidth: Self.edgeWidth)))
            .frame(width: diameter, height: diameter)
    }
}

public enum MapGround {
    public static let land = Cockpit.Color.mapLand
    public static let veil = (dark: 0.45, light: 0.3)
    public static let dim = Cockpit.Color.mapDim
}
