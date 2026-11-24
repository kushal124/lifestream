import Cockpit
import HomeLink
import LifestreamCaptureCore
import MapKit
import SwiftUI
import UIKit

struct PlacesMap: UIViewRepresentable {
    struct Mark: Identifiable, Equatable {
        enum Kind: Equatable {
            case place(String, hours: Double, faded: Bool, lit: Bool)
            case spot(String, open: Bool)
            case city(String, places: Int, strong: Bool, faded: Bool)
            case here
            case stay
        }

        let id: String
        let kind: Kind
        let centre: PlaceCoordinate
        var name: String?
        var reach: Double?
        var lit = false
        var quiet = false

        static func place(_ place: PlacesSnapshot.Place, named: Bool = true, reach: Bool = false, lit: Bool = false,
                          back: Bool = false) -> Mark {
            Mark(id: "place:" + place.id, kind: .place(place.id, hours: place.hours, faded: false, lit: lit),
                 centre: place.centre, name: named ? place.name : nil, reach: reach ? place.radiusMeters : nil)
        }

        static func places(_ place: PlacesSnapshot.Place, named: Bool = true, reach: Bool = false, lit: Bool = false,
                           back: Bool = false) -> [Mark] {
            let first = Self.place(place, named: named, reach: reach, lit: lit, back: back)
            return [first] + place.also.enumerated().map { index, circle in
                Mark(id: first.id + "#\(index + 1)", kind: first.kind, centre: circle.centre, reach: reach ? circle.radiusMeters : nil)
            }
        }

        var counted: String {
            if case .place(let id, _, _, _) = kind { return "place:" + id }
            return id
        }

        static func spot(_ spot: PlacesSnapshot.Spot, open: Bool = false) -> Mark {
            Mark(id: "spot:" + spot.id, kind: .spot(spot.id, open: open), centre: spot.centre, reach: open ? PlaceRules.reachMeters : nil)
        }

        static func places(_ row: HomeLink.Pages.PlaceRow, named: Bool = true, reach: Bool = false, back: Bool = false) -> [Mark] {
            let first = Mark(id: "place:" + row.slug, kind: .place(row.slug, hours: row.hours, faded: false, lit: false),
                             centre: row.centre, name: named ? row.name : nil, reach: reach ? row.radiusM : nil)
            return [first] + row.also.enumerated().map { index, circle in
                Mark(id: first.id + "#\(index + 1)", kind: first.kind, centre: circle.circle.centre, reach: reach ? circle.radiusM : nil)
            }
        }

        static func spot(_ row: HomeLink.Pages.SpotRow) -> Mark {
            Mark(id: "spot:" + row.id, kind: .spot(row.id, open: false), centre: row.centre)
        }

        static func hidden(_ row: HomeLink.Pages.HiddenRow) -> Mark {
            Mark(id: "hidden:" + row.key, kind: .spot(row.key, open: true), centre: row.centre, reach: PlaceRules.reachMeters)
        }

        static func here(_ here: Here) -> Mark {
            Mark(id: "here", kind: .here, centre: here.centre, name: "You're here")
        }
    }

    struct Focus: Equatable {
        static let streets: Double = 1_200
        static let city: Double = 12_000

        let id: AnyHashable
        let points: [PlaceCoordinate]
        var span: Double = Focus.streets
    }

    var marks: [Mark]
    var focus: Focus?
    var moves = true
    var insets: EdgeInsets = EdgeInsets()
    var open: (Mark) -> Void = { _ in }

    func makeUIView(context: Context) -> FocusingMapView {
        let map = FocusingMapView()
        map.isRotateEnabled = true
        map.isUserInteractionEnabled = moves
        map.delegate = context.coordinator
        return map
    }

    func updateUIView(_ map: FocusingMapView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        let margins = UIEdgeInsets(top: insets.top, left: insets.leading, bottom: insets.bottom, right: insets.trailing)
        if map.layoutMargins != margins { map.layoutMargins = margins }
        coordinator.layer.draw(marks, on: map)
        if let focus, focus.id != coordinator.focused {
            let animated = coordinator.focused != nil
            coordinator.focused = focus.id
            map.show(Self.rect(focus), animated: animated)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    static func rect(_ focus: Focus) -> MKMapRect {
        var rect = MKMapRect.null
        for point in focus.points {
            rect = rect.union(MKMapRect(origin: MKMapPoint(point.clLocation), size: MKMapSize(width: 0, height: 0)))
        }
        guard !rect.isNull else { return rect }
        let latitude = rect.origin.coordinate.latitude
        let least = focus.span * MKMapPointsPerMeterAtLatitude(latitude)
        let width = max(rect.width * 1.15, least), height = max(rect.height * 1.15, least)
        return MKMapRect(x: rect.midX - width / 2, y: rect.midY - height / 2, width: width, height: height)
    }


    @MainActor final class Coordinator: NSObject, MKMapViewDelegate {
        var parent: PlacesMap
        var focused: AnyHashable?
        let layer = MarkLayer()

        init(parent: PlacesMap) {
            self.parent = parent
        }

        func mapView(_ map: MKMapView, viewFor annotation: any MKAnnotation) -> MKAnnotationView? {
            layer.view(for: annotation, on: map)
        }

        func mapViewDidFinishRenderingMap(_ map: MKMapView, fullyRendered: Bool) {
            if fullyRendered { (map as? FocusingMapView)?.reveal() }
        }

        func mapViewDidChangeVisibleRegion(_ map: MKMapView) { layer.fit(on: map) }

        func mapView(_ map: MKMapView, didSelect annotation: any MKAnnotation) {
            map.deselectAnnotation(annotation, animated: false)
            if let view = map.view(for: annotation) as? PressedMarkView, view.held {
                view.lifted = { [weak self, weak map] in if let map { self?.act(on: annotation, map) } }
            } else if PressedMarkView.touching == nil {
                act(on: annotation, map)
            }
        }

        private func act(on annotation: any MKAnnotation, _ map: MKMapView) {
            if let cluster = annotation as? MKClusterAnnotation {
                let points = cluster.memberAnnotations.map { PlaceCoordinate(latitude: $0.coordinate.latitude, longitude: $0.coordinate.longitude) }
                (map as? FocusingMapView)?.show(PlacesMap.rect(Focus(id: 0, points: points, span: 200)), animated: true)
            } else if let mark = (annotation as? MarkAnnotation)?.mark {
                parent.open(mark)
            }
        }
    }
}

@MainActor final class MarkLayer {
    private var drawn: [String: MarkAnnotation] = [:]
    private var reaches: [String: ReachAnnotation] = [:]

    func draw(_ marks: [PlacesMap.Mark], on map: MKMapView) {
        let wanted = Dictionary(marks.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let gone = drawn.filter { wanted[$0.key] == nil }
        map.removeAnnotations(Array(gone.values))
        for id in gone.keys { drawn[id] = nil }
        var added: [MarkAnnotation] = []
        for mark in wanted.values {
            if let annotation = drawn[mark.id] {
                guard annotation.mark != mark else { continue }
                annotation.mark = mark
                (map.view(for: annotation) as? MarkView)?.draw()
            } else {
                let annotation = MarkAnnotation(mark)
                drawn[mark.id] = annotation
                added.append(annotation)
            }
        }
        map.addAnnotations(added)

        let circles = wanted.compactMapValues { mark in mark.reach.map { ReachAnnotation(centre: mark.centre, radius: $0, quiet: mark.quiet) } }
        let stale = reaches.filter { id, reach in
            circles[id].map { $0.centre != reach.centre || $0.radius != reach.radius || $0.quiet != reach.quiet } ?? true
        }
        map.removeAnnotations(Array(stale.values))
        for id in stale.keys { reaches[id] = nil }
        let laid = circles.filter { reaches[$0.key] == nil }
        for (id, reach) in laid { reaches[id] = reach }
        map.addAnnotations(Array(laid.values))
    }

    func view(for annotation: any MKAnnotation, on map: MKMapView) -> MKAnnotationView? {
        switch annotation {
        case let mark as MarkAnnotation:
            return map.dequeueReusableAnnotationView(withIdentifier: MarkView.reuse, for: mark)
        case let reach as ReachAnnotation:
            let view = map.dequeueReusableAnnotationView(withIdentifier: ReachView.reuse, for: reach) as? ReachView
            view?.fit(on: map)
            return view
        default:
            return nil
        }
    }

    func fit(on map: MKMapView) {
        for reach in reaches.values { (map.view(for: reach) as? ReachView)?.fit(on: map) }
    }
}

final class MarkAnnotation: NSObject, MKAnnotation {
    var mark: PlacesMap.Mark {
        didSet { if mark.centre != oldValue.centre { coordinate = mark.centre.clLocation } }
    }
    @objc dynamic var coordinate: CLLocationCoordinate2D

    init(_ mark: PlacesMap.Mark) {
        self.mark = mark
        self.coordinate = mark.centre.clLocation
    }
}

final class ReachAnnotation: NSObject, MKAnnotation {
    let centre: PlaceCoordinate
    let radius: Double
    let quiet: Bool
    var coordinate: CLLocationCoordinate2D { centre.clLocation }

    init(centre: PlaceCoordinate, radius: Double, quiet: Bool = false) {
        self.centre = centre
        self.radius = radius
        self.quiet = quiet
    }
}

@MainActor enum MarkArt {
    enum Figure: Hashable {
        case disc(CGFloat, faded: Bool, lit: Bool)
        case ring(open: Bool, lit: Bool)
        case stay(lit: Bool)
        case here
        case cluster(Int)
        case name(String, faded: Bool, strong: Bool)
    }

    private struct Look: Hashable {
        let figure: Figure
        let dark: Bool
        let scale: CGFloat
        let high: Bool
    }

    private static var drawn: [Look: UIImage] = [:]

    static func image(_ figure: Figure, in traits: UITraitCollection) -> UIImage? {
        let look = Look(figure: figure, dark: traits.userInterfaceStyle != .light, scale: traits.displayScale > 0 ? traits.displayScale : 3,
                        high: traits.accessibilityContrast == .high)
        if let image = drawn[look] { return image }
        let renderer = ImageRenderer(content: view(figure)
            .environment(\.colorScheme, look.dark ? .dark : .light)
            .environment(\._colorSchemeContrast, look.high ? .increased : .standard))
        renderer.scale = look.scale
        let image = renderer.uiImage
        drawn[look] = image
        return image
    }

    @ViewBuilder private static func view(_ figure: Figure) -> some View {
        switch figure {
        case .disc(let diameter, let faded, let lit): PlaceDisc(diameter: diameter, faded: faded, lit: lit)
        case .ring(let open, let lit): SpotRing(open: open, lit: lit)
        case .stay(let lit): StayDot(lit: lit)
        case .here: HereMark()
        case .cluster(let count): ClusterDisc(count: count)
        case .name(let name, let faded, let strong): MapName(name, faded: faded, strong: strong).padding(.horizontal, 2)
        }
    }
}

class PressedMarkView: MKAnnotationView {
    private let halo = UIView()
    private(set) var held = false
    var lifted: (() -> Void)?
    static weak var touching: PressedMarkView?
    private var start: CGPoint?

    override init(annotation: (any MKAnnotation)?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        halo.isUserInteractionEnabled = false
        halo.isHidden = true
        halo.layer.cornerRadius = Cockpit.Size.target / 2
        addSubview(halo)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    var point: CGPoint { CGPoint(x: bounds.midX, y: bounds.midY) }

    override func layoutSubviews() {
        super.layoutSubviews()
        halo.bounds = CGRect(x: 0, y: 0, width: Cockpit.Size.target, height: Cockpit.Size.target)
        halo.center = point
    }

    private func hold(_ on: Bool) {
        held = on
        halo.backgroundColor = UIColor(Cockpit.Color.pressed).resolvedColor(with: traitCollection)
        halo.isHidden = !on
        setNeedsLayout()
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesBegan(touches, with: event)
        guard isEnabled else { return }
        hold(true)
        Self.touching = self
        start = touches.first?.location(in: nil)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesMoved(touches, with: event)
        if held, let start, let now = touches.first?.location(in: nil),
           hypot(now.x - start.x, now.y - start.y) > Cockpit.Size.target / 2 {
            hold(false)
            lifted = nil
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesEnded(touches, with: event)
        let open = held
        hold(false)
        if open { lifted?() }
        lifted = nil
        if Self.touching === self { Self.touching = nil }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesCancelled(touches, with: event)
        hold(false)
        lifted = nil
        if Self.touching === self { Self.touching = nil }
    }
}

final class MarkView: PressedMarkView {
    static let reuse = "mark"
    private let name = UIImageView()
    private let disc = UIImageView()

    override var point: CGPoint { disc.center }

    override var annotation: (any MKAnnotation)? {
        didSet { draw() }
    }

    override init(annotation: (any MKAnnotation)?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        addSubview(disc)
        addSubview(name)
        isAccessibilityElement = true
        accessibilityTraits = .button
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitDisplayScale.self, UITraitAccessibilityContrast.self]) {
            (view: MarkView, _) in view.draw()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    static func priority(hours: Double) -> MKFeatureDisplayPriority {
        MKFeatureDisplayPriority(rawValue: Float(min(990, 300 + 60 * log2(1 + max(0, hours)))))
    }

    func draw() {
        guard let mark = (annotation as? MarkAnnotation)?.mark else { return }
        let figure: MarkArt.Figure
        var label: MarkArt.Figure?
        var cluster: String?
        var priority = MKFeatureDisplayPriority.required
        var collision = MKAnnotationView.CollisionMode.circle
        var z = MKAnnotationViewZPriority.defaultUnselected
        switch mark.kind {
        case .place(_, let hours, let faded, let lit):
            figure = .disc(MapMarks.disc, faded: faded, lit: lit)
            label = mark.name.map { .name($0, faded: faded, strong: false) }
            cluster = lit ? nil : "places"
            if lit { z = .max } else { priority = Self.priority(hours: hours) }
            collision = .rectangle
        case .spot(_, let open):
            figure = .ring(open: open, lit: mark.lit)
            priority = open ? .required : .defaultLow
            z = open ? .max : .min
        case .city(_, _, let strong, let faded):
            figure = .disc(MapMarks.disc, faded: faded, lit: false)
            label = mark.name.map { .name($0, faded: faded, strong: strong) }
            cluster = "cities"
            collision = .rectangle
        case .here:
            figure = .here
            collision = .none
            z = .max
        case .stay:
            figure = .stay(lit: mark.lit)
            collision = .none
            z = .min
        }
        if clusteringIdentifier != cluster { clusteringIdentifier = cluster }
        if collisionMode != collision { collisionMode = collision }
        if displayPriority != priority { displayPriority = priority }
        if zPriority != z { zPriority = z }
        let image = MarkArt.image(figure, in: traitCollection)
        disc.image = image
        name.image = label.flatMap { MarkArt.image($0, in: traitCollection) }
        let size = image?.size ?? .zero, picture = name.image?.size
        let top = picture.map { $0.height + MapMarks.nameGap } ?? 0
        let width = max(size.width, picture?.width ?? 0)
        bounds = CGRect(x: 0, y: 0, width: width, height: top + size.height)
        disc.frame = CGRect(x: (width - size.width) / 2, y: top, width: size.width, height: size.height)
        if let picture { name.frame = CGRect(x: (width - picture.width) / 2, y: 0, width: picture.width, height: picture.height) }
        centerOffset = CGPoint(x: 0, y: -top / 2)
        name.isHidden = name.image == nil
        setNeedsLayout()
        switch mark.kind {
        case .spot: accessibilityLabel = "A place to name"
        case .stay: accessibilityLabel = nil
        default: accessibilityLabel = mark.name
        }
        isAccessibilityElement = mark.kind != .stay
    }
}

final class ReachView: MKAnnotationView {
    static let reuse = "reach"
    private let circle = CAShapeLayer()

    override var annotation: (any MKAnnotation)? {
        didSet { paint() }
    }

    override init(annotation: (any MKAnnotation)?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        displayPriority = .required
        collisionMode = .none
        zPriority = .min
        isEnabled = false
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        layer.addSublayer(circle)
        paint()
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self]) { (view: ReachView, _) in view.paint() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func fit(on map: MKMapView) {
        guard let reach = annotation as? ReachAnnotation else { return }
        let centre = MKMapPoint(reach.coordinate)
        let edge = MKMapPoint(x: centre.x + reach.radius * MKMapPointsPerMeterAtLatitude(reach.coordinate.latitude), y: centre.y)
        let from = map.convert(reach.coordinate, toPointTo: map), to = map.convert(edge.coordinate, toPointTo: map)
        let side = (2 * hypot(to.x - from.x, to.y - from.y)).rounded()
        guard side.isFinite, side != bounds.width else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        bounds = CGRect(x: 0, y: 0, width: side, height: side)
        circle.frame = bounds
        circle.path = UIBezierPath(ovalIn: bounds.insetBy(dx: circle.lineWidth / 2, dy: circle.lineWidth / 2)).cgPath
        CATransaction.commit()
    }

    private func paint() {
        let quiet = (annotation as? ReachAnnotation)?.quiet ?? false
        circle.lineWidth = Cockpit.Stroke.border
        circle.lineDashPattern = quiet ? Cockpit.Dash.plan.map { NSNumber(value: Double($0)) } : nil
        circle.fillColor = quiet ? nil : UIColor(Cockpit.Color.accent.opacity(0.1)).resolvedColor(with: traitCollection).cgColor
        circle.strokeColor = UIColor(quiet ? ReachCircle.quietEdge : Cockpit.Color.accent.opacity(0.6)).resolvedColor(with: traitCollection).cgColor
    }
}

final class ClusterView: PressedMarkView {
    override var annotation: (any MKAnnotation)? {
        didSet { draw() }
    }

    override init(annotation: (any MKAnnotation)?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        displayPriority = .required
        collisionMode = .circle
        isAccessibilityElement = true
        accessibilityTraits = .button
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitDisplayScale.self, UITraitAccessibilityContrast.self]) {
            (view: ClusterView, _) in view.draw()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private func draw() {
        guard let cluster = annotation as? MKClusterAnnotation else { return }
        let count = Set(cluster.memberAnnotations.map { annotation in
            (annotation as? MarkAnnotation)?.mark.counted ?? ObjectIdentifier(annotation).debugDescription
        }).count
        image = MarkArt.image(.cluster(count), in: traitCollection)
        let cities = cluster.memberAnnotations.contains { annotation in
            if case .city = (annotation as? MarkAnnotation)?.mark.kind { true } else { false }
        }
        accessibilityLabel = "\(count) \(cities ? "cities" : "places")"
    }
}

class FocusingMapView: GroundMapView {
    override class var veiled: Bool { true }
    static let room = UIEdgeInsets(top: 40, left: 32, bottom: 56, right: 32)
    private var waiting: MKMapRect?
    override init(frame: CGRect) {
        super.init(frame: frame)
        preferredConfiguration = MKStandardMapConfiguration.places
        isPitchEnabled = false
        showsUserLocation = false
        insetsLayoutMarginsFromSafeArea = false
        register(MarkView.self, forAnnotationViewWithReuseIdentifier: MarkView.reuse)
        register(ReachView.self, forAnnotationViewWithReuseIdentifier: ReachView.reuse)
        register(ClusterView.self, forAnnotationViewWithReuseIdentifier: MKMapViewDefaultClusterAnnotationViewReuseIdentifier)
        isAccessibilityElement = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func show(_ rect: MKMapRect, animated: Bool) {
        guard !rect.isNull else { return }
        guard laidOut else {
            waiting = rect
            return
        }
        waiting = nil
        setVisibleMapRect(rect, edgePadding: Self.room, animated: animated && UIView.areAnimationsEnabled && !UIAccessibility.isReduceMotionEnabled)
    }

    private var laidOut: Bool {
        let margins = layoutMargins
        return bounds.width > margins.left + margins.right + Self.room.left + Self.room.right
            && bounds.height > margins.top + margins.bottom + Self.room.top + Self.room.bottom
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if let waiting, laidOut {
            self.waiting = nil
            setVisibleMapRect(waiting, edgePadding: Self.room, animated: false)
        }
    }
}

extension MKStandardMapConfiguration {
    static var places: MKStandardMapConfiguration {
        let configuration = MKStandardMapConfiguration(elevationStyle: .flat, emphasisStyle: .muted)
        configuration.pointOfInterestFilter = .excludingAll
        configuration.showsTraffic = false
        return configuration
    }
}

extension PlaceCoordinate {
    init(_ point: HomeLink.Where.Point) {
        self.init(latitude: point.latitude, longitude: point.longitude)
    }

    var clLocation: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: latitude, longitude: longitude) }
}
