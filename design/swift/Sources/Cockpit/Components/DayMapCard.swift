import MapKit
import SwiftUI

public struct DayMapCard: View {
    public struct Stay: Identifiable {
        public let id: String
        public let name: String
        public let point: CLLocationCoordinate2D
        public let minutes: Int
        public let time: String
        public let reach: CLLocationDistance

        public init(id: String, name: String, point: CLLocationCoordinate2D, minutes: Int, time: String,
                    reach: CLLocationDistance = 100) {
            self.id = id
            self.name = name
            self.point = point
            self.minutes = minutes
            self.time = time
            self.reach = reach
        }
    }

    public static let height: CGFloat = 168

    let stays: [Stay]?
    let open: (String) -> Void
    var drawn = false
    @Environment(\.cockpitPlatform) private var platform

    public init(stays: [Stay]?, open: @escaping (String) -> Void) {
        self.stays = stays
        self.open = open
    }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous)
        GeometryReader { proxy in
            if let stays, !stays.isEmpty {
                let frame = MapFrame(stays: stays, size: proxy.size, phone: platform == .ios)
                ZStack(alignment: .topLeading) {
                    if !drawn { still(frame) }
                    marks(stays, frame)
                }
            }
        }
        .frame(height: Self.height)
        .background(MapGround.land)
        .clipShape(shape)
        .padding(.horizontal, Cockpit.Gap.edge)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(stays.map { "Map of the day: " + $0.map(\.name).joined(separator: ", ") } ?? "Map of the day")
    }

    @ViewBuilder private func still(_ frame: MapFrame) -> some View {
        #if canImport(UIKit)
        StillMap(rect: frame.rect)
            .frame(width: frame.size.width, height: frame.size.height)
            .accessibilityHidden(true)
        #endif
    }

    private func marks(_ stays: [Stay], _ frame: MapFrame) -> some View {
        ZStack(alignment: .topLeading) {
            ForEach(stays.sorted { $0.minutes > $1.minutes }) { stay in
                disc(stay, frame).position(frame.project(stay.point))
            }
            ForEach(stays) { stay in
                if let box = frame.labels[stay.id] {
                    StayLabel(name: stay.name, time: stay.time)
                        .position(x: box.midX, y: box.midY)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
        }
    }

    private func disc(_ stay: Stay, _ frame: MapFrame) -> some View {
        let radius = frame.radius[stay.id] ?? MapFrame.least
        return Button { open(stay.id) } label: {
            ZStack {
                Circle().fill(MapMarks.ink.opacity(0.22))
                Circle().strokeBorder(MapMarks.ink, lineWidth: MapMarks.edge)
                Circle().fill(MapMarks.ink).frame(width: MapFrame.dot, height: MapFrame.dot)
            }
            .frame(width: 2 * radius, height: 2 * radius)
            .frame(width: max(Cockpit.Size.target, 2 * radius), height: max(Cockpit.Size.target, 2 * radius))
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(stay.name), \(Self.spoken(stay.minutes))")
    }

    static func spoken(_ minutes: Int) -> String {
        let hours = minutes / 60, rest = minutes % 60
        return [hours > 0 ? "\(hours) \(hours == 1 ? "hour" : "hours")" : nil,
                rest > 0 || hours == 0 ? "\(rest) \(rest == 1 ? "minute" : "minutes")" : nil]
            .compactMap { $0 }.joined(separator: " ")
    }
}

private struct StayLabel: View {
    let name: String
    let time: String
    @Environment(\.cockpitPlatform) private var platform

    var body: some View {
        let phone = platform == .ios
        HStack(spacing: MapFrame.timeGap) {
            Text(phone ? MapMarks.short(name) : name).foregroundStyle(Cockpit.Color.text)
            Text(time).foregroundStyle(Cockpit.Color.textSecondary)
        }
        .font(.system(size: MapFrame.labelSize(phone: phone), weight: phone ? .regular : .medium))
        .lineLimit(1)
        .fixedSize()
        .modifier(LabelGround(phone: phone))
    }
}

private struct LabelGround: ViewModifier {
    let phone: Bool

    func body(content: Content) -> some View {
        if phone {
            content
                .padding(.horizontal, MapFrame.capsulePadding.width)
                .padding(.vertical, MapFrame.capsulePadding.height)
                .background { Capsule().fill(Cockpit.Color.raised) }
        } else {
            content.mapHalo()
        }
    }
}

struct MapFrame {
    static let padding: CGFloat = 12
    static let closest = 16.5
    static let least: CGFloat = 6
    static let grows: CGFloat = 18
    static let dot: CGFloat = 3
    static let labelGap: CGFloat = 6
    static let timeGap: CGFloat = 6
    static let capsulePadding = CGSize(width: Cockpit.Space.s2, height: 2)
    static let markWidth: CGFloat = 96
    static let markHeight: CGFloat = 26

    static func labelSize(phone: Bool) -> CGFloat { phone ? 13 : 11 }

    let rect: MKMapRect
    let size: CGSize
    let radius: [String: CGFloat]
    let labels: [String: CGRect]
    private let scale: Double

    init(stays: [DayMapCard.Stay], size: CGSize, phone: Bool) {
        self.size = size
        let most = max(1, stays.map(\.minutes).max() ?? 1)
        var radius: [String: CGFloat] = [:]
        for stay in stays {
            radius[stay.id] = Self.least + Self.grows * CGFloat(sqrt(Double(max(0, stay.minutes)) / Double(most)))
        }
        self.radius = radius
        let points = stays.map { (MKMapPoint($0.point), Double(radius[$0.id] ?? Self.least)) }
        let wide = max(1, Double(size.width)), tall = max(1, Double(size.height))
        let pad = Double(Self.padding)
        let xs = points.map(\.0.x), ys = points.map(\.0.y)
        let minX = xs.min() ?? 0, maxX = xs.max() ?? 0, minY = ys.min() ?? 0, maxY = ys.max() ?? 0
        let closest = pow(2, Self.closest - 20)
        var scale: Double
        if let only = stays.first, maxX - minX < 1, maxY - minY < 1 {
            let span = MKMapPointsPerMeterAtLatitude(only.point.latitude) * only.reach * 6
            scale = min(min(wide, tall) / max(span, 1), closest)
        } else {
            func fits(_ scale: Double) -> Bool {
                let left = points.map { $0.0.x * scale - $0.1 }.min() ?? 0, right = points.map { $0.0.x * scale + $0.1 }.max() ?? 0
                let top = points.map { $0.0.y * scale - $0.1 }.min() ?? 0, bottom = points.map { $0.0.y * scale + $0.1 }.max() ?? 0
                return right - left <= wide - 2 * pad && bottom - top <= tall - 2 * pad
            }
            var low = 0.0, high = closest
            if fits(high) { low = high } else {
                for _ in 0..<60 { let mid = (low + high) / 2; if fits(mid) { low = mid } else { high = mid } }
            }
            scale = max(low, 1e-12)
        }
        self.scale = scale
        let left = points.map { $0.0.x * scale - $0.1 }.min() ?? 0, right = points.map { $0.0.x * scale + $0.1 }.max() ?? 0
        let top = points.map { $0.0.y * scale - $0.1 }.min() ?? 0, bottom = points.map { $0.0.y * scale + $0.1 }.max() ?? 0
        let centre = MKMapPoint(x: (left + right) / 2 / scale, y: (top + bottom) / 2 / scale)
        let rect = MKMapRect(x: centre.x - wide / 2 / scale, y: centre.y - tall / 2 / scale, width: wide / scale,
                             height: tall / scale)
        self.rect = rect

        var kept: [CGRect] = stays.map { stay in
            let at = Self.project(stay.point, rect, scale), r = radius[stay.id] ?? Self.least
            return CGRect(x: at.x - r, y: at.y - r, width: 2 * r, height: 2 * r)
        }
        let card = CGRect(origin: .zero, size: size).insetBy(dx: 4, dy: 4)
        let mark = CGRect(x: 0, y: size.height - Self.markHeight, width: Self.markWidth, height: Self.markHeight)
        var labels: [String: CGRect] = [:]
        for stay in stays.sorted(by: { $0.minutes > $1.minutes }) {
            let at = Self.project(stay.point, rect, scale), r = radius[stay.id] ?? Self.least
            let label = Self.labelSize(stay, phone: phone)
            let gap = r + Self.labelGap
            let toLeft = at.x > size.width / 2
            let beside = { (left: Bool) in
                CGRect(x: left ? at.x - gap - label.width : at.x + gap, y: at.y - label.height / 2,
                       width: label.width, height: label.height)
            }
            let above = CGRect(x: at.x - label.width / 2, y: at.y - gap - label.height, width: label.width, height: label.height)
            let under = CGRect(x: at.x - label.width / 2, y: at.y + gap, width: label.width, height: label.height)
            let slant = gap * 0.71
            let corner = { (left: Bool, up: Bool) in
                CGRect(x: left ? at.x - slant - label.width : at.x + slant, y: up ? at.y - slant - label.height : at.y + slant,
                       width: label.width, height: label.height)
            }
            let corners = [corner(toLeft, true), corner(toLeft, false), corner(!toLeft, true), corner(!toLeft, false)]
            for box in [beside(toLeft), beside(!toLeft), above, under] + corners
            where card.contains(box) && !box.intersects(mark) && kept.allSatisfy({ !$0.intersects(box) }) {
                kept.append(box)
                labels[stay.id] = box
                break
            }
        }
        self.labels = labels
    }

    func project(_ point: CLLocationCoordinate2D) -> CGPoint { Self.project(point, rect, scale) }

    private static func project(_ point: CLLocationCoordinate2D, _ rect: MKMapRect, _ scale: Double) -> CGPoint {
        let at = MKMapPoint(point)
        return CGPoint(x: (at.x - rect.minX) * scale, y: (at.y - rect.minY) * scale)
    }

    private static func labelSize(_ stay: DayMapCard.Stay, phone: Bool) -> CGSize {
        let size = labelSize(phone: phone)
        #if canImport(UIKit)
        let font = UIFont.systemFont(ofSize: size, weight: phone ? .regular : .medium)
        #else
        let font = NSFont.systemFont(ofSize: size, weight: phone ? .regular : .medium)
        #endif
        let name = (phone ? MapMarks.short(stay.name) : stay.name) as NSString
        let width = name.size(withAttributes: [.font: font]).width + timeGap
            + (stay.time as NSString).size(withAttributes: [.font: font]).width
        #if canImport(UIKit)
        let line = font.lineHeight
        #else
        let line = ceil(font.ascender - font.descender + font.leading)
        #endif
        let padding = phone ? capsulePadding : CGSize(width: 2, height: 1)
        return CGSize(width: ceil(width + 2 * padding.width), height: ceil(line + 2 * padding.height))
    }
}
