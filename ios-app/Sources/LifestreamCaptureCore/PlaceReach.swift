import Foundation

public enum PlaceReach {
    public static let smallest = PlaceRules.radiusMinimumMeters
    public static let largest = PlaceRules.radiusMaximumMeters

    static func notchWidth(at metres: Double) -> Double { metres < 100 ? 5 : metres < 500 ? 10 : 50 }

    static func held(_ metres: Double) -> Double { min(largest, max(smallest, metres)) }

    public static let ladder: [Double] = {
        var sizes = [smallest]
        while let last = sizes.last, last < largest { sizes.append(notch(last, 1)) }
        return sizes
    }()

    public static func snap(_ metres: Double) -> Double {
        guard metres.isFinite else { return smallest }
        let size = held(metres), width = notchWidth(at: size)
        return held((size / width).rounded(.toNearestOrAwayFromZero) * width)
    }

    public static func notch(_ metres: Double, _ way: Int) -> Double {
        guard metres.isFinite else { return smallest }
        if way > 0 {
            let width = notchWidth(at: metres)
            return held((metres / width + 1e-9).rounded(.down) * width + width)
        }
        let width = notchWidth(at: metres - 1e-6)
        return held((metres / width - 1e-9).rounded(.up) * width - width)
    }

    public static let marks: [Double] = ladder.filter { $0 <= 500 ? $0.truncatingRemainder(dividingBy: 50) == 0
        : $0.truncatingRemainder(dividingBy: 250) == 0 }

    public static func ticks(from: Double, to: Double) -> Bool {
        guard from != to else { return false }
        let (low, high) = (min(from, to), max(from, to))
        return marks.contains { $0 == to || ($0 > low && $0 < high) }
    }

    public static func words(_ metres: Double) -> String {
        if metres < 1_000 { return "\(Int(metres.rounded()))\(Words.nbsp)m" }
        var km = String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), metres / 1_000)
        while km.hasSuffix("0") { km.removeLast() }
        if km.hasSuffix(".") { km.removeLast() }
        return km + Words.nbsp + "km"
    }
}

public struct KeyedCircle: Sendable, Equatable {
    public let slug: String
    public let circle: PlaceCircle

    public init(slug: String, circle: PlaceCircle) {
        self.slug = slug
        self.circle = circle
    }
}

public struct StayPoint: Sendable, Equatable, Hashable {
    public let centre: PlaceCoordinate
    public let count: Int

    public init(centre: PlaceCoordinate, count: Int) {
        self.centre = centre
        self.count = count
    }
}

public enum PlaceTakes {
    static let metresPerDegreeAtLeast: Double = 110_000

    public static func winning(_ point: PlaceCoordinate, among circles: [KeyedCircle]) -> KeyedCircle? {
        var best: (circle: KeyedCircle, distance: Double)?
        for each in circles {
            let radius = each.circle.radiusMeters
            if abs(point.latitude - each.circle.centre.latitude) * metresPerDegreeAtLeast > radius { continue }
            let distance = point.distance(to: each.circle.centre)
            if distance > radius { continue }
            guard let held = best else {
                best = (each, distance)
                continue
            }
            let heldRadius = held.circle.circle.radiusMeters
            if radius < heldRadius || (radius == heldRadius && (distance < held.distance
                || (distance == held.distance && each.slug.utf16.lexicographicallyPrecedes(held.circle.slug.utf16)))) {
                best = (each, distance)
            }
        }
        return best?.circle
    }

    public static func takesIn(_ circle: KeyedCircle, others: [KeyedCircle], points: [StayPoint]) -> Int {
        let circles = [circle] + others
        return points.reduce(0) { taken, point in winning(point.centre, among: circles)?.slug == circle.slug ? taken + point.count : taken }
    }

    static let besideReach: Double = 200
    static let besidePoint: Double = 500

    public static func beside(_ circles: [PlaceCircle], anchor: Int, points: [PlaceCoordinate]) -> PlaceCircle {
        let beside = circles[anchor]
        let reach = min(beside.radiusMeters, besideReach)
        let free = { (point: PlaceCoordinate) in !circles.contains { $0.holds(point) } }
        let point = points
            .filter { $0.distance(to: beside.centre) <= besidePoint && free($0) }
            .min { $0.distance(to: beside.centre) < $1.distance(to: beside.centre) }
        if let point { return PlaceCircle(centre: point.held, radiusMeters: reach) }
        let away = beside.radiusMeters + reach
        let around = (0..<8).map { step in
            let bearing = Double(step) * .pi / 4
            return beside.centre.moved(north: away * sin(bearing), east: away * cos(bearing))
        }
        return PlaceCircle(centre: around.first(where: free) ?? around[0], radiusMeters: reach)
    }
}

extension PlaceCoordinate {
    public static let metresPerDegreeOfLatitude: Double = 111_320

    public var held: PlaceCoordinate {
        var wrapped = (longitude + 180).truncatingRemainder(dividingBy: 360)
        if wrapped < 0 { wrapped += 360 }
        return PlaceCoordinate(latitude: min(85, max(-85, latitude)), longitude: wrapped - 180)
    }

    public func moved(north: Double, east: Double) -> PlaceCoordinate {
        let degree = Self.metresPerDegreeOfLatitude
        return PlaceCoordinate(latitude: latitude + north / degree,
                               longitude: longitude + east / (degree * max(0.01, cos(latitude * .pi / 180)))).held
    }
}

public struct PlaceTake: Sendable, Equatable {
    public let stays: Int?
    public let overlaps: [String]

    public init(stays: Int?, overlaps: [String]) {
        self.stays = stays
        self.overlaps = overlaps
    }

    public static func overlapping(_ circle: PlaceCircle, others: [KeyedCircle]) -> [String] {
        var nearest: [String: Double] = [:]
        for other in others where other.circle.centre.distance(to: circle.centre) < other.circle.radiusMeters + circle.radiusMeters {
            let distance = other.circle.centre.distance(to: circle.centre)
            nearest[other.slug] = min(nearest[other.slug] ?? distance, distance)
        }
        return nearest.sorted { ($0.value, $0.key) < ($1.value, $1.key) }.map(\.key)
    }

    public func words(unread: String?) -> String {
        var line = stays.map { $0 == 0 ? "Takes in no stays" : "Takes in " + Words.count($0, "stay") } ?? unread ?? "Stays not read yet"
        switch overlaps.count {
        case 0: break
        case 1: line += Words.dot + "overlaps " + overlaps[0]
        case 2: line += Words.dot + "overlaps " + overlaps[0] + " and " + overlaps[1]
        default: line += Words.dot + "overlaps " + overlaps[0] + " and " + Words.count(overlaps.count - 1) + " more"
        }
        return line
    }
}
