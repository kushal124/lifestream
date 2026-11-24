import Foundation
import HomeLink
import os

private let placesLog = Logger(subsystem: "org.lifestreamprotocol.phone", category: "places")

public actor PlacesBook {
    private let folder: URL
    private let link: HomeLink
    private var held: Copy?
    private var copy: Copy {
        get {
            if held == nil { held = Self.read(folder.appendingPathComponent("places.json")) }
            return held ?? Copy()
        }
        set { held = newValue }
    }
    private var built: PlacesSnapshot?
    private var unpaired = false { didSet { if unpaired != oldValue { built = nil } } }
    private var refreshing: Task<Void, Never>?
    private var again = false
    private let clock: @Sendable () -> Date
    public private(set) var listRead = false

    public init(folder: URL, link: HomeLink, clock: @escaping @Sendable () -> Date = { AppClock.now }) {
        self.folder = folder
        self.link = link
        self.clock = clock
    }


    public var snapshot: PlacesSnapshot {
        if let built { return built }
        let snapshot = PlacesSnapshot(places: copy.places.sorted { ($0.name, $0.id) < ($1.name, $1.id) }, spots: copy.spots,
                                      hidden: copy.hidden.sorted { ($0.hiddenAt, $0.id) > ($1.hiddenAt, $1.id) },
                                      dayUntil: copy.dayUntil, counting: copy.counting, unpaired: unpaired)
        if held != nil { built = snapshot }
        return snapshot
    }

    public func refresh() async {
        again = true
        if let refreshing { return await refreshing.value }
        let task = Task {
            while again {
                again = false
                await read()
            }
            refreshing = nil
        }
        refreshing = task
        await task.value
    }

    public func act(_ change: HomeLink.PlaceAct, request: String) async -> HomeLink.Acted {
        let acted = await link.acted(.places(request: request, change), now: clock())
        switch acted {
        case .answered: await refresh()
        case .refused(let refusal) where refusal.code == Self.changed: await refresh()
        case .refused, .unanswered: break
        }
        return acted
    }

    public static let changed = "CHANGED"

    private func read() async {
        do {
            if let answer = try await link.places(etag: copy.etag) {
                guard let object = (try? JSONSerialization.jsonObject(with: answer.body)) as? [String: Any] else {
                    placesLog.error("the home's places did not read; the copy stands")
                    return
                }
                copy = Copy(answer: object, etag: answer.etag)
                built = nil
                do {
                    try FileDurability.createDirectoryDurably(at: folder)
                    try FileDurability.excludeFromBackup(folder)
                    try JSONSerialization.data(withJSONObject: ["etag": answer.etag as Any? ?? NSNull(), "answer": object] as [String: Any], options: [.sortedKeys])
                        .write(to: folder.appendingPathComponent("places.json"), options: FileDurability.unlockedOnly)
                } catch {
                    placesLog.error("the places copy was not written: \(String(describing: error), privacy: .public)")
                }
            }
            listRead = true
            unpaired = false
        } catch let failure as LinkFailure {
            switch failure {
            case .refused(status: 401, _, _), .unpaired: unpaired = true
            default: break
            }
        } catch {}
    }


    private static func read(_ file: URL) -> Copy? {
        guard let data = try? Data(contentsOf: file) else {
            return FileManager.default.fileExists(atPath: file.path) ? nil : Copy()
        }
        return Copy(file: data) ?? Copy()
    }

    struct Copy: Sendable {
        var places: [PlacesSnapshot.Place] = []
        var spots: [PlacesSnapshot.Spot] = []
        var hidden: [PlacesSnapshot.Hidden] = []
        var dayUntil: Date?
        var counting = false
        var etag: String?

        init() {}

        init?(file: Data) {
            guard let object = (try? JSONSerialization.jsonObject(with: file)) as? [String: Any],
                  let answer = object["answer"] as? [String: Any] else { return nil }
            self.init(answer: answer, etag: object["etag"] as? String)
        }

        init(answer object: [String: Any], etag: String?) {
            places = (object["places"] as? [[String: Any]] ?? []).compactMap { stated in
                guard let id = stated["slug"] as? String, let name = stated["name"] as? String,
                      let centre = Self.centre(stated), let radius = stated["radius_m"] as? Double else { return nil }
                let also = (stated["also"] as? [[String: Any]] ?? []).compactMap { circle in
                    Self.centre(circle).flatMap { centre in
                        (circle["radius_m"] as? Double).map { PlaceCircle(centre: centre, radiusMeters: $0) }
                    }
                }
                var place = PlacesSnapshot.Place(id: id, name: name, centre: centre, radiusMeters: radius, also: also,
                                                 ids: stated["ids"] as? [String] ?? [], home: stated["home"] as? Bool)
                (place.stays, place.days, place.hours, place.first, place.last) = Self.figures(stated)
                place.todayHours = stated["today_hours"] as? Double ?? 0
                place.area = Self.area(stated)
                place.askHome = stated["ask_home"] as? String
                place.counting = stated["counting"] as? Bool ?? false
                return place
            }
            spots = Self.spots(object["spots"])
            hidden = Self.hidden(object["hidden"])
            dayUntil = (object["day_until_ms"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) }
            counting = object["counting"] as? Bool ?? false
            self.etag = etag
        }

        private static func spots(_ stated: Any?) -> [PlacesSnapshot.Spot] {
            guard let stated, let bytes = try? JSONSerialization.data(withJSONObject: ["spots": stated]) else { return [] }
            do {
                return try HomeLink.Places.spots(in: bytes)
            } catch {
                placesLog.error("the home's spots did not read; none are shown")
                return []
            }
        }

        private static func hidden(_ stated: Any?) -> [PlacesSnapshot.Hidden] {
            guard let stated, let bytes = try? JSONSerialization.data(withJSONObject: ["hidden": stated]) else { return [] }
            do {
                return try HomeLink.Places.hidden(in: bytes)
            } catch {
                placesLog.error("the home's hidden spots did not read; none are shown")
                return []
            }
        }

        private static func centre(_ stated: [String: Any]) -> PlaceCoordinate? {
            guard let latitude = stated["latitude"] as? Double, let longitude = stated["longitude"] as? Double else { return nil }
            return PlaceCoordinate(latitude: latitude, longitude: longitude)
        }

        private static func area(_ stated: [String: Any]) -> PlacesSnapshot.Area? {
            guard let area = stated["area"] as? [String: Any] else { return nil }
            return .init(city: area["city"] as? String, region: area["region"] as? String, country: area["country"] as? String)
        }

        private static func figures(_ stated: [String: Any]) -> (Int, Int, Double, Date?, Date?) {
            func date(_ key: String) -> Date? {
                (stated[key] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) }
            }
            return (stated["stays"] as? Int ?? 0, stated["days"] as? Int ?? 0, stated["hours"] as? Double ?? 0,
                    date("first_ms"), date("last_ms"))
        }
    }
}

@MainActor
public final class PlaceAttempt {
    private var held: (change: HomeLink.PlaceAct, request: String)?

    public init() {}

    public func act(_ change: HomeLink.PlaceAct, on book: PlacesBook) async -> HomeLink.Acted {
        let request = held.flatMap { $0.change == change ? $0.request : nil } ?? UUID().uuidString
        held = (change, request)
        let acted = await book.act(change, request: request)
        if case .unanswered = acted { return acted }
        if held?.request == request { held = nil }
        return acted
    }
}

extension PlacesSnapshot {
    public func here(fixes: [PlaceFix], now: Date) -> Here? {
        Here.dwelling(fixes: fixes, now: now).map { Here(centre: $0.centre, since: $0.since, place: placeOf($0.centre), spot: spot(near: $0.centre)) }
    }
}

extension Here {
    public static func dwelling(fixes: [PlaceFix], now: Date) -> Here? {
        let recent = fixes.filter { $0.readable && $0.at <= now && $0.at >= now.addingTimeInterval(-PlaceRules.dwellWindow) }
            .sorted { $0.at < $1.at }
        guard let newest = recent.last, now.timeIntervalSince(newest.at) <= PlaceRules.dwellFreshness else { return nil }
        var group = FixGroup()
        for fix in recent.reversed() {
            if !group.include(fix) { break }
        }
        guard let since = group.earliest, newest.at.timeIntervalSince(since) >= PlaceRules.dwellPrompt else { return nil }
        return Here(centre: group.centre, since: since, place: nil, spot: nil)
    }
}

private struct FixGroup {
    private var members: [PlaceFix] = []
    private(set) var centre = PlaceCoordinate(latitude: 0, longitude: 0)
    private var bound = 0.0

    var earliest: Date? { members.map(\.at).min() }

    mutating func include(_ fix: PlaceFix) -> Bool {
        let count = Double(members.count)
        let candidate = PlaceCoordinate(latitude: centre.latitude + (fix.centre.latitude - centre.latitude) / (count + 1),
                                        longitude: centre.longitude + (fix.centre.longitude - centre.longitude) / (count + 1))
        let distance = candidate.distance(to: fix.centre)
        guard distance <= PlaceRules.reachMeters else { return false }
        var next = members.isEmpty ? 0 : bound + centre.distance(to: candidate)
        if next > PlaceRules.reachMeters {
            next = 0
            for member in members {
                next = max(next, member.centre.distance(to: candidate))
                if next > PlaceRules.reachMeters { return false }
            }
        }
        centre = candidate
        bound = max(next, distance)
        members.append(fix)
        return true
    }
}

extension CaptureStore {
    static let placeFixesQuery = "SELECT line FROM location WHERE captured_wall >= ? AND kind = 'fix' ORDER BY captured_wall"

    public func placeFixes(since: Date) async throws -> [PlaceFix] {
        return try await snapshot { database in
            var fixes: [PlaceFix] = []
            let decoder = JSONDecoder.lifestream()
            try database.query(Self.placeFixesQuery, .real(since.timeIntervalSince1970)) { row in
                guard let fix = try decoder.decode(LocationLine.self, from: row.blob(0)).fix, fix.at >= since else { return }
                fixes.append(fix)
            }
            return fixes
        }
    }
}

private struct LocationLine: Decodable {
    var payload: Payload

    struct Payload: Decodable {
        var location: Location?
    }

    struct Location: Decodable {
        var timestamp_unix_seconds: Double?
        var latitude: Double?
        var longitude: Double?
        var horizontal_accuracy: Double?
    }

    var fix: PlaceFix? {
        guard let location = payload.location, let time = location.timestamp_unix_seconds,
              let latitude = location.latitude, let longitude = location.longitude,
              let accuracy = location.horizontal_accuracy else { return nil }
        let fix = PlaceFix(at: Date(timeIntervalSince1970: time), centre: .init(latitude: latitude, longitude: longitude),
                           horizontalAccuracyMeters: accuracy)
        return fix.readable ? fix : nil
    }
}
