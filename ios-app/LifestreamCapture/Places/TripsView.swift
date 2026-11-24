import Cockpit
import Combine
import HomeLink
import LifestreamCaptureCore
import MapKit
import SwiftUI

@MainActor
final class YearPages: ObservableObject {
    @Published private(set) var page: HomeLink.Pages.Year?
    @Published private(set) var failure: LifeReader.Failure?
    @Published private(set) var span: HomeLink.Pages.YearSpan?
    private(set) var year: Int
    private var reading: PageReading<HomeLink.Pages.Year>
    private var following: [AnyCancellable] = []

    init(_ year: Int) {
        self.year = year
        reading = Self.reading(year)
        follow()
    }

    static func reading(_ year: Int) -> PageReading<HomeLink.Pages.Year> {
        PageReading(HomeLink.PageKey(HomeLink.Pages.Year.route, ["year": String(year)]))
    }

    var loading: Bool { page == nil && failure == nil }

    func read(_ year: Int) async {
        if year != self.year {
            reading.forget()
            self.year = year
            reading = Self.reading(year)
            follow()
        }
        await reading.read()
    }

    private func follow() {
        following = [
            reading.$drawn.sink { [weak self] drawn in
                self?.page = drawn?.page
                if let span = drawn?.page?.span { self?.span = span }
            },
            reading.$failure.sink { [weak self] failure in self?.failure = failure },
        ]
    }
}

struct TripsView: View {
    @Binding var year: Int
    @ObservedObject var pages: YearPages
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s6) {
            let span = pages.span.map { min($0.first, year)...max($0.last, year) } ?? year...year
            MonthMenu("Year", shown: Binding(get: { MonthMenu.Month(year: year) }, set: { year = $0.year }),
                      months: span.reversed().map { MonthMenu.Month(year: $0) })
                .accessibilityIdentifier("places.year")
            if let page = pages.page {
                content(page)
            } else if let failure = pages.failure {
                ReadLack(failure, lacks: "Your trips aren't on this iPhone yet.", words: PlacesWords.failure(failure), retry: retry)
            } else {
                reading
            }
            GeographyCredit()
        }
        .animation(.easeOut(duration: Cockpit.Duration.fast), value: pages.loading)
    }

    @ViewBuilder private var reading: some View {
        MapBox(height: 240)
        FigureStrip {
            ForEach(["Nights away", "Countries", "Cities"], id: \.self) { label in
                Figure("00", label: label)
            }
        }
        .reading(true)
        VStack(alignment: .leading, spacing: 0) {
            Card(group: true, flat: true) {
                let names = ["Synthetic City", "Synthetic Bay and Old Town", "Synthetic Hills", "Lake Town", "Synthetic City", "The Coast"]
                VStack(spacing: 0) {
                    ForEach(names.indices, id: \.self) { index in
                        ListRow(names[index], meta: "10–12 Oct · 3 nights", mono: true, separator: index < names.count - 1, action: {})
                    }
                }
                .reading(true)
            }
            WaitLine()
        }
        .waiting(true)
        .id(year)
    }

    @ViewBuilder private func content(_ page: HomeLink.Pages.Year) -> some View {
        let cities = TripsMap.cities(page)
        if !cities.isEmpty {
            TripsMap(cities: cities, label: "Where you slept in \(page.year)")
                .frame(height: 240)
        }
        FigureStrip {
            ForEach(page.figures, id: \.words) { figure in
                Figure(Words.count(figure.count), label: figure.words)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("places.trips.figures")
        if page.trips.isEmpty {
            NoneLine("No nights away from home in \(String(page.year)).")
        } else {
            Card(group: true, flat: true) {
                ForEach(Array(page.trips.enumerated()), id: \.element.range.first) { index, trip in
                    ListRow(trip.title, meta: PlacesWords.range(trip.range) + Words.dot + trip.nights + (trip.guessed ? Words.dot + "a guess" : ""),
                            mono: true, separator: index < page.trips.count - 1,
                            action: { AppNavigation.shared.push(.trip(trip.range.first)) })
                        .accessibilityIdentifier("places.trip.\(trip.range.first)")
                }
            }
        }
    }
}

struct MapBox: View {
    let height: CGFloat
    var corner: CGFloat = Cockpit.Radius.lg

    var body: some View {
        RoundedRectangle(cornerRadius: corner, style: .continuous)
            .fill(Cockpit.Color.raised)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .accessibilityHidden(true)
    }
}

struct GeographyCredit: View {
    var body: some View {
        Text("Place names: GeoNames (CC BY 4.0), Natural Earth")
            .cockpit(.footnote)
            .foregroundStyle(Cockpit.Color.textTertiary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct TripsMap: View {
    struct City: Equatable, Identifiable {
        let name: String
        let point: PlaceCoordinate
        let nights: Int
        let home: Bool
        var id: String { "\(point.cell) \(name)" }
    }

    static func cities(_ year: HomeLink.Pages.Year) -> [City] {
        year.cities.compactMap { city in
            city.point.map { City(name: city.name, point: PlaceCoordinate(latitude: $0.latitude, longitude: $0.longitude), nights: city.nights, home: city.base) }
        }
    }

    static func route(_ trip: HomeLink.Pages.Year.Trip, in year: HomeLink.Pages.Year) -> [City] {
        let cities = cities(year)
        let stops = trip.route.compactMap { name in cities.first { $0.name == name } }
        guard let home = cities.first(where: \.home) else { return stops }
        return [home] + stops + [home]
    }

    let cities: [City]
    var route = false
    let label: String

    var body: some View {
        TripsMapView(drawing: drawing, region: region)
            .clipShape(RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous))
            .accessibilityElement()
            .accessibilityLabel(label)
            .accessibilityValue(unique.map(\.name).joined(separator: ", "))
    }

    var drawing: TripsDrawing { TripsDrawing(cities: unique, lines: lines) }

    private var unique: [TripsMap.City] {
        var seen: Set<String> = []
        return cities.filter { seen.insert($0.id).inserted }
    }

    private var lines: [[PlaceCoordinate]] {
        route ? [cities.map(\.point)] : []
    }

    private var region: MKCoordinateRegion {
        let lats = cities.map(\.point.latitude), lons = cities.map(\.point.longitude)
        let (south, north, west, east) = (lats.min() ?? 0, lats.max() ?? 0, lons.min() ?? 0, lons.max() ?? 0)
        return MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: (south + north) / 2, longitude: (west + east) / 2),
                                  span: MKCoordinateSpan(latitudeDelta: max((north - south) * 1.6, 6.4),
                                                         longitudeDelta: max((east - west) * 1.5, 10.7)))
    }
}

struct TripsDrawing: Equatable {
    let cities: [TripsMap.City]
    let lines: [[PlaceCoordinate]]

    struct Changes: Equatable {
        var marks: Bool
        var lines: Bool
        var fit: Bool
    }

    func changes(from old: TripsDrawing?) -> Changes {
        guard let old else { return Changes(marks: true, lines: true, fit: true) }
        return Changes(marks: cities != old.cities, lines: lines != old.lines,
                       fit: cities.map(\.point) != old.cities.map(\.point))
    }
}

private struct TripsMapView: UIViewRepresentable {
    let drawing: TripsDrawing
    let region: MKCoordinateRegion

    func makeUIView(context: Context) -> FittingMapView {
        let map = FittingMapView()
        map.preferredConfiguration = MKStandardMapConfiguration.places
        map.isPitchEnabled = false
        map.showsUserLocation = false
        map.showsCompass = false
        map.isAccessibilityElement = false
        map.register(CityView.self, forAnnotationViewWithReuseIdentifier: CityView.reuse)
        map.delegate = context.coordinator
        return map
    }

    func updateUIView(_ map: FittingMapView, context: Context) {
        let coordinator = context.coordinator
        let changes = drawing.changes(from: coordinator.drawn)
        coordinator.drawn = drawing
        if changes.lines {
            map.removeOverlays(map.overlays)
            map.addOverlays(drawing.lines.map { line in
                let points = line.map(\.clLocation)
                return MKGeodesicPolyline(coordinates: points, count: points.count)
            })
        }
        if changes.marks {
            map.removeAnnotations(map.annotations)
            let most = Double(drawing.cities.map(\.nights).max() ?? 1)
            for city in drawing.cities {
                map.addAnnotation(CityAnnotation(city: city, most: most, name: false))
                map.addAnnotation(CityAnnotation(city: city, most: most, name: true))
            }
        }
        if changes.fit { map.fit(region) }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor final class Coordinator: NSObject, MKMapViewDelegate {
        var drawn: TripsDrawing?

        func mapView(_ map: MKMapView, viewFor annotation: any MKAnnotation) -> MKAnnotationView? {
            map.dequeueReusableAnnotationView(withIdentifier: CityView.reuse, for: annotation)
        }

        func mapView(_ map: MKMapView, rendererFor overlay: any MKOverlay) -> MKOverlayRenderer {
            let line = MKPolylineRenderer(overlay: overlay)
            line.strokeColor = UIColor(Cockpit.Color.data2)
            line.lineWidth = 1.25
            line.lineJoin = .round
            return line
        }

        func mapViewDidFinishRenderingMap(_ map: MKMapView, fullyRendered: Bool) {
            if fullyRendered { (map as? GroundMapView)?.reveal() }
        }
    }
}

private final class FittingMapView: GroundMapView {
    private var waiting: MKCoordinateRegion?

    func fit(_ region: MKCoordinateRegion) {
        waiting = region
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let waiting, bounds.width > 0, bounds.height > 0 else { return }
        self.waiting = nil
        setRegion(waiting, animated: false)
    }
}

private final class CityAnnotation: NSObject, MKAnnotation {
    let city: TripsMap.City
    let most: Double
    let name: Bool
    var coordinate: CLLocationCoordinate2D { city.point.clLocation }

    init(city: TripsMap.City, most: Double, name: Bool) {
        self.city = city
        self.most = most
        self.name = name
    }
}

private final class CityView: MKAnnotationView {
    static let reuse = "city"
    private let ring = CAShapeLayer()
    private let dot = CAShapeLayer()
    private let picture = UIImageView()

    override var annotation: (any MKAnnotation)? {
        didSet { draw() }
    }

    override init(annotation: (any MKAnnotation)?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        isEnabled = false
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        layer.addSublayer(ring)
        layer.addSublayer(dot)
        addSubview(picture)
        draw()
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitDisplayScale.self, UITraitAccessibilityContrast.self]) {
            (view: CityView, _) in view.draw()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private func draw() {
        guard let city = annotation as? CityAnnotation else { return }
        let life = UIColor(Cockpit.Color.life).resolvedColor(with: traitCollection).cgColor
        if city.name {
            picture.image = MarkArt.image(.name(city.city.name, faded: false, strong: city.city.home), in: traitCollection)
            let size = picture.image?.size ?? .zero
            bounds = CGRect(origin: .zero, size: size)
            picture.frame = bounds
            centerOffset = CGPoint(x: 0, y: -(size.height / 2 + CityView.side(city) / 2 + MapMarks.nameGap))
            collisionMode = .rectangle
            displayPriority = city.city.home ? .required
                : MKFeatureDisplayPriority(rawValue: Float(min(990, 300 + 60 * log2(1 + Double(city.city.nights)))))
            ring.path = nil
            dot.path = nil
        } else {
            picture.image = nil
            let side = CityView.side(city)
            bounds = CGRect(x: 0, y: 0, width: side, height: side)
            centerOffset = .zero
            collisionMode = .none
            displayPriority = .required
            if city.city.home {
                ring.path = UIBezierPath(ovalIn: bounds.insetBy(dx: 0.75, dy: 0.75)).cgPath
                ring.lineWidth = 1.5
                ring.strokeColor = life
                ring.fillColor = nil
                let inner: CGFloat = 5.2
                dot.path = UIBezierPath(ovalIn: CGRect(x: (side - inner) / 2, y: (side - inner) / 2, width: inner, height: inner)).cgPath
            } else {
                ring.path = nil
                dot.path = UIBezierPath(ovalIn: bounds).cgPath
            }
            dot.fillColor = life
        }
    }

    private static func side(_ city: CityAnnotation) -> CGFloat {
        if city.city.home { return 11 }
        return 2 * (2.2 + 3.2 * (Double(max(city.city.nights, 1)) / max(city.most, 1)).squareRoot())
    }
}
