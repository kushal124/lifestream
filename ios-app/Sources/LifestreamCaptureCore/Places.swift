import Foundation
import HomeLink


public struct PlaceCoordinate: Sendable, Equatable, Hashable, Codable {
    public var latitude: Double
    public var longitude: Double

    public init(latitude: Double, longitude: Double) {
        self.latitude = latitude
        self.longitude = longitude
    }

    public func distance(to other: PlaceCoordinate) -> Double {
        let radius = 6_371_008.8
        let phi1 = latitude * .pi / 180, phi2 = other.latitude * .pi / 180
        let dPhi = (other.latitude - latitude) * .pi / 180
        let dLambda = (other.longitude - longitude) * .pi / 180
        let a = sin(dPhi / 2) * sin(dPhi / 2) + cos(phi1) * cos(phi2) * sin(dLambda / 2) * sin(dLambda / 2)
        return radius * 2 * atan2(sqrt(a), sqrt(1 - a))
    }

    public var cell: String {
        String(format: "%.3f,%.3f", locale: Locale(identifier: "en_US_POSIX"), latitude, longitude)
    }

    var inRange: Bool {
        latitude.isFinite && longitude.isFinite && (-90...90).contains(latitude) && (-180...180).contains(longitude)
    }
}

public enum PlaceRules {
    public static let accuracyCeilingMeters: Double = 100
    public static let reachMeters: Double = 80
    public static let dwellPrompt: TimeInterval = 20 * 60
    public static let dwellFreshness: TimeInterval = 10 * 60
    public static let dwellWindow: TimeInterval = 2 * 60 * 60
    public static let radiusMinimumMeters: Double = 20
    public static let radiusMaximumMeters: Double = 2_000
    public static let newPlaceRadiusMeters: Double = reachMeters
}

public struct PlaceFix: Sendable, Equatable {
    public var at: Date
    public var centre: PlaceCoordinate
    public var horizontalAccuracyMeters: Double

    public init(at: Date, centre: PlaceCoordinate, horizontalAccuracyMeters: Double) {
        self.at = at
        self.centre = centre
        self.horizontalAccuracyMeters = horizontalAccuracyMeters
    }

    var readable: Bool {
        at.timeIntervalSince1970.isFinite && centre.inRange && horizontalAccuracyMeters.isFinite
            && horizontalAccuracyMeters >= 0 && horizontalAccuracyMeters <= PlaceRules.accuracyCeilingMeters
    }
}

public struct PlaceCircle: Sendable, Equatable, Hashable {
    public var centre: PlaceCoordinate
    public var radiusMeters: Double

    public init(centre: PlaceCoordinate, radiusMeters: Double) {
        self.centre = centre
        self.radiusMeters = radiusMeters
    }

    public func holds(_ point: PlaceCoordinate) -> Bool {
        centre.distance(to: point) <= radiusMeters
    }

    fileprivate var held: PlaceCircle? {
        guard centre.inRange, radiusMeters.isFinite else { return nil }
        return PlaceCircle(centre: centre, radiusMeters: min(PlaceRules.radiusMaximumMeters, max(PlaceRules.radiusMinimumMeters, radiusMeters)))
    }
}

public struct PlaceContent: Sendable, Equatable {
    public let name: String
    public let centre: PlaceCoordinate
    public let radiusMeters: Double
    public let also: [PlaceCircle]
    public let ids: [String]
    public let home: Bool?

    public static let alsoMaximum = 19

    public init?(name: String, centre: PlaceCoordinate, radiusMeters: Double, also: [PlaceCircle] = [], ids: [String] = [],
                 home: Bool? = nil) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 200, let first = PlaceCircle(centre: centre, radiusMeters: radiusMeters).held,
              also.count <= Self.alsoMaximum else { return nil }
        let others = also.compactMap(\.held)
        guard others.count == also.count else { return nil }
        self.name = trimmed
        self.centre = first.centre
        self.radiusMeters = first.radiusMeters
        self.also = others
        self.ids = Array(Set(ids)).sorted()
        self.home = home
    }
}

public struct PlacesSnapshot: Sendable, Equatable {
    public struct Area: Sendable, Equatable, Hashable {
        public var city: String?
        public var region: String?
        public var country: String?

        public init(city: String?, region: String?, country: String?) {
            self.city = city
            self.region = region
            self.country = country
        }

        public var name: String? { city ?? region ?? country }
    }

    public struct Place: Sendable, Equatable, Identifiable {
        public var id: String
        public var name: String
        public var centre: PlaceCoordinate
        public var radiusMeters: Double
        public var also: [PlaceCircle] = []
        public var ids: [String]
        public var home: Bool?
        public var stays = 0
        public var days = 0
        public var hours = 0.0
        public var first: Date?
        public var last: Date?
        public var todayHours = 0.0
        public var area: Area?
        public var askHome: String?
        public var counting = false

        public init(id: String, name: String, centre: PlaceCoordinate, radiusMeters: Double, also: [PlaceCircle] = [], ids: [String] = [],
                    home: Bool? = nil) {
            self.id = id
            self.name = name
            self.centre = centre
            self.radiusMeters = radiusMeters
            self.also = also
            self.ids = ids
            self.home = home
        }

        public var circles: [PlaceCircle] { [PlaceCircle(centre: centre, radiusMeters: radiusMeters)] + also }

        public func distance(to point: PlaceCoordinate) -> Double {
            circles.map { $0.centre.distance(to: point) }.min() ?? centre.distance(to: point)
        }

        public func content() -> PlaceContent? {
            PlaceContent(name: name, centre: centre, radiusMeters: radiusMeters, also: also, ids: ids, home: home)
        }
    }

    public typealias Spot = HomeLink.Spot
    public typealias Hidden = HomeLink.HiddenSpot

    public var places: [Place]
    public var spots: [Spot]
    public var hidden: [Hidden]
    public var dayUntil: Date?
    public var counting = false
    public var unpaired = false

    public init(places: [Place], spots: [Spot], hidden: [Hidden] = [], dayUntil: Date? = nil, counting: Bool = false,
                unpaired: Bool = false) {
        self.places = places
        self.spots = spots
        self.hidden = hidden
        self.dayUntil = dayUntil
        self.counting = counting
        self.unpaired = unpaired
    }

    public static let empty = PlacesSnapshot(places: [], spots: [])

    public func hoursToday(_ place: Place, now: Date) -> Double {
        guard let dayUntil, now < dayUntil else { return 0 }
        return place.todayHours
    }

    public func isHidden(_ point: PlaceCoordinate) -> Bool {
        hidden.contains { $0.centre.distance(to: point) <= PlaceRules.reachMeters }
    }

    public func placeOf(_ point: PlaceCoordinate) -> Place? {
        places.flatMap { place in
            place.circles.filter { $0.holds(point) }.map { (place, $0.radiusMeters, $0.centre.distance(to: point)) }
        }.min { a, b in
            if a.1 != b.1 { return a.1 < b.1 }
            if a.2 != b.2 { return a.2 < b.2 }
            return a.0.id < b.0.id
        }?.0
    }

    public func spot(near point: PlaceCoordinate) -> Spot? {
        spots.map { ($0, $0.centre.distance(to: point)) }.filter { $0.1 <= PlaceRules.reachMeters }.min { $0.1 < $1.1 }?.0
    }
}

public struct Here: Sendable, Equatable {
    public var centre: PlaceCoordinate
    public var since: Date
    public var place: PlacesSnapshot.Place?
    public var spot: PlacesSnapshot.Spot?
}

extension HomeLink.Spot {
    public var centre: PlaceCoordinate { PlaceCoordinate(latitude: latitude, longitude: longitude) }
    public var lastDate: Date? { lastMs.map { Date(timeIntervalSince1970: TimeInterval($0) / 1000) } }
}

extension HomeLink.HiddenSpot {
    public var centre: PlaceCoordinate { PlaceCoordinate(latitude: latitude, longitude: longitude) }
    public var hiddenAt: Date { Date(timeIntervalSince1970: TimeInterval(hiddenMs) / 1000) }
}

extension HomeLink.Where.Area {
    public var name: String? { city ?? region ?? country }
}
