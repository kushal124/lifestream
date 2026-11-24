import Cockpit
import HomeLink
import LifestreamCaptureCore
import MapKit
import SwiftUI
import UIKit

@Observable @MainActor
final class CircleEditing {
    private var circles: [PlaceCircle]
    private(set) var selected = 0
    private(set) var centre: PlaceCoordinate
    private(set) var radius: Double
    private(set) var lifted = false
    private(set) var metresPerPoint: Double = 0
    @ObservationIgnored private var side: Double = 0
    private(set) var take: PlaceTake
    private(set) var slug: String
    private(set) var others: [KeyedCircle] = []
    private(set) var points: [StayPoint] = []
    private(set) var unread: String?
    @ObservationIgnored private var held = 0
    @ObservationIgnored private var read = false
    private var takes: [Int: PlaceTake] = [:]
    private(set) var moved = "Where it was"
    private(set) var changed = false
    private(set) var flight: Flight

    private var ids: [Int]
    @ObservationIgnored private var origins: [PlaceCoordinate]
    @ObservationIgnored private let start: [PlaceCircle]
    @ObservationIgnored let place: @MainActor (String) -> PlacesSnapshot.Place?
    @ObservationIgnored weak var history: UIResponder?
    @ObservationIgnored private let haptics = PlaceHaptics()
    @ObservationIgnored private var holding: Step?
    @ObservationIgnored private var before: Step?
    @ObservationIgnored private var flying = false

    struct Flight: Equatable {
        let id: Int
        let centre: PlaceCoordinate
        let fit: Double?
        let animated: Bool
    }

    private struct Step: Equatable {
        let circles: [PlaceCircle]
        let ids: [Int]
        let selected: Int
    }

    @ObservationIgnored let aside: CGFloat

    static let fitted = 0.3
    static let comfortable = 0.12...0.44
    init(_ circles: [PlaceCircle], slug: String, place: @escaping @MainActor (String) -> PlacesSnapshot.Place? = { _ in nil }, aside: CGFloat = 0) {
        precondition(!circles.isEmpty, "a circle to set")
        self.aside = aside
        self.circles = circles
        self.slug = slug
        self.place = place
        start = circles
        ids = Array(circles.indices)
        origins = circles.map(\.centre)
        let centre = circles[0].centre, radius = circles[0].radiusMeters
        self.centre = centre
        self.radius = radius
        take = PlaceTake(stays: nil, overlaps: [])
        flight = Flight(id: 0, centre: centre, fit: radius, animated: false)
        retake()
        retakeOthers()
        haptics.prepare()
    }

    func know(_ page: HomeLink.Pages.PlaceEdit) {
        slug = page.slug
        others = page.others.filter { $0.slug != page.slug }.map { other in
            KeyedCircle(slug: other.slug, circle: PlaceCircle(centre: PlaceCoordinate(latitude: other.latitude, longitude: other.longitude),
                                                              radiusMeters: other.radiusM))
        }
        points = page.points.map { StayPoint(centre: PlaceCoordinate(latitude: $0.latitude, longitude: $0.longitude), count: $0.count) }
        held = page.held
        read = page.read
        unread = page.line
        retake()
        retakeOthers()
    }

    struct Row: Identifiable, Equatable {
        let id: Int
        let number: Int
        let circle: PlaceCircle
        let line: String
        let selected: Bool
    }

    var rows: [Row] {
        circles.indices.map { index in
            let id = ids[index]
            return Row(id: id, number: index + 1, circle: circles[index], line: (index == selected ? take : takes[id] ?? take).words(unread: unread),
                       selected: index == selected)
        }
    }

    var line: String { take.words(unread: unread) }

    func taken(_ point: StayPoint) -> Bool {
        PlaceTakes.winning(point.centre, among: others + standing.map { KeyedCircle(slug: slug, circle: $0) })?.slug == slug
    }

    private func taking(_ circle: PlaceCircle, at index: Int, among standing: [PlaceCircle]) -> PlaceTake {
        let own = standing.indices.filter { $0 != index }.map { KeyedCircle(slug: slug, circle: standing[$0]) }
        let overlaps = PlaceTake.overlapping(circle, others: others).compactMap { place($0)?.name }
        guard read else { return PlaceTake(stays: nil, overlaps: overlaps) }
        return PlaceTake(stays: held + PlaceTakes.takesIn(KeyedCircle(slug: slug, circle: circle), others: others + own, points: points),
                         overlaps: overlaps)
    }

    var standing: [PlaceCircle] {
        var all = circles
        all[selected] = PlaceCircle(centre: centre, radiusMeters: radius)
        return all
    }

    static let most = PlaceContent.alsoMaximum + 1

    var canAdd: Bool { circles.count < Self.most }

    private var still: Bool { holding == nil && !lifted }

    @discardableResult
    func select(id: Int) -> Bool {
        guard let index = ids.firstIndex(of: id) else { return false }
        return select(index)
    }

    @discardableResult
    func select(at point: PlaceCoordinate) -> Bool {
        let holding = circles.indices.filter { circles[$0].centre.distance(to: point) <= circles[$0].radiusMeters }
        let smallest = holding.min { one, other in
            (circles[one].radiusMeters, circles[one].centre.distance(to: point))
                < (circles[other].radiusMeters, circles[other].centre.distance(to: point))
        }
        return smallest.map { select($0) } ?? false
    }

    func remove(id: Int) {
        guard still, circles.count > 1, let index = ids.firstIndex(of: id) else { return }
        let was = step
        circles.remove(at: index)
        ids.remove(at: index)
        if index == selected {
            selected = max(0, index - 1)
            settle()
        } else if index < selected {
            selected -= 1
        }
        retakeOthers()
        commit(from: was, as: "Remove Circle")
        haptics.place()
    }

    func add() {
        guard still, canAdd else { return }
        let was = step
        let circle = PlaceTakes.beside(circles, anchor: selected, points: points.map(\.centre))
        ids.append(origins.count)
        origins.append(circle.centre)
        circles.append(circle)
        selected = circles.count - 1
        settle()
        retakeOthers()
        commit(from: was, as: "Add Circle")
        haptics.place()
        var added = AttributedString("Circle \(circles.count) added")
        added.accessibilitySpeechAnnouncementPriority = .high
        AccessibilityNotification.Announcement(added).post()
        var how = AttributedString("Move the map to set it")
        how.accessibilitySpeechAnnouncementPriority = .low
        AccessibilityNotification.Announcement(how).post()
    }

    private func select(_ index: Int) -> Bool {
        guard still, index != selected, circles.indices.contains(index) else { return false }
        selected = index
        settle()
        retakeOthers()
        haptics.tap()
        return true
    }


    func scale(_ metresPerPoint: Double, side: Double) {
        self.side = side
        guard metresPerPoint.isFinite, metresPerPoint > 0, abs(metresPerPoint - self.metresPerPoint) > self.metresPerPoint * 0.0005 else { return }
        self.metresPerPoint = metresPerPoint
    }

    func lift() {
        guard !lifted else { return }
        lifted = true
        before = step
    }

    func move(to middle: PlaceCoordinate) {
        let middle = middle.held
        guard middle != centre else { return }
        centre = middle
        retake()
    }

    func set() {
        guard lifted else { return }
        lifted = false
        if let before { commit(from: before, as: "Move") }
        before = nil
        say()
    }

    func landed() { flying = false }


    func hold(_ held: Bool) {
        if held {
            holding = step
        } else if let was = holding {
            holding = nil
            commit(from: was, as: "Resize")
            if !fits { fly(fit: radius) }
        }
    }

    func resize(_ metres: Double) {
        guard metres != radius else { return }
        let was = step
        radius = metres
        retake()
        guard holding == nil else {
            if !flying, ratio > Self.comfortable.upperBound { fly(fit: radius) }
            return
        }
        commit(from: was, as: "Resize")
        if !fits { fly(fit: radius) }
    }

    func nudge(_ way: CircleEditor.Nudge) {
        let (north, east): (Double, Double) = switch way {
        case .north: (5, 0)
        case .south: (-5, 0)
        case .east: (0, 5)
        case .west: (0, -5)
        }
        let was = step
        centre = centre.moved(north: north, east: east)
        retake()
        commit(from: was, as: "Move")
        say()
        fly(fit: nil)
    }


    private var step: Step { Step(circles: circles, ids: ids, selected: selected) }

    private func commit(from was: Step, as name: String) {
        let now = PlaceCircle(centre: centre, radiusMeters: radius)
        if circles[selected] != now { circles[selected] = now }
        changed = circles != start
        let after = step
        guard after != was else { return }
        register(was, again: after, as: name)
    }

    private func register(_ back: Step, again: Step, as name: String) {
        history?.undoManager?.registerUndo(withTarget: self) { editing in
            MainActor.assumeIsolated { editing.restore(back, again: again, as: name) }
        }
        history?.undoManager?.setActionName(name)
    }

    func listen() { history?.becomeFirstResponder() }

    private func restore(_ back: Step, again: Step, as name: String) {
        circles = back.circles
        ids = back.ids
        selected = back.selected
        changed = circles != start
        settle()
        retakeOthers()
        register(again, again: back, as: name)
    }


    private func settle() {
        centre = circles[selected].centre
        radius = circles[selected].radiusMeters
        retake()
        say()
        fly(fit: fits ? nil : radius)
    }

    private func retakeOthers() {
        let all = standing
        var now: [Int: PlaceTake] = [:]
        for (index, circle) in circles.enumerated() where index != selected {
            now[ids[index]] = taking(circle, at: index, among: all)
        }
        if now != takes { takes = now }
    }

    private func retake() {
        let now = taking(PlaceCircle(centre: centre, radiusMeters: radius), at: selected, among: standing)
        if now != take { take = now }
    }

    private func say() {
        let from = origins[ids[selected]]
        let metres = from.distance(to: centre)
        guard metres >= 1 else {
            moved = "Where it was"
            return
        }
        let north = (centre.latitude - from.latitude) * PlaceCoordinate.metresPerDegreeOfLatitude
        var across = centre.longitude - from.longitude
        if across > 180 { across -= 360 } else if across < -180 { across += 360 }
        let east = across * PlaceCoordinate.metresPerDegreeOfLatitude * cos(from.latitude * .pi / 180)
        let ways = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]
        let bearing = (atan2(east, north) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
        let far = metres < 1_000 ? "\(Int(metres.rounded()))\(Words.nbsp)m"
            : String(format: "%.1f", locale: Locale(identifier: "en_US_POSIX"), metres / 1_000) + "\(Words.nbsp)km"
        moved = "Moved " + far + " " + ways[Int((bearing + 22.5) / 45) % 8]
    }

    private var ratio: Double {
        guard metresPerPoint > 0, side > 0 else { return Self.fitted }
        return radius / metresPerPoint / side
    }

    private var fits: Bool { Self.comfortable.contains(ratio) }

    private func fly(fit: Double?) {
        flying = true
        flight = Flight(id: flight.id + 1, centre: centre, fit: fit, animated: true)
    }
}

struct CircleEdit: View {
    let editing: CircleEditing

    var body: some View {
        CircleMap(editing: editing, marks: marks, flight: editing.flight)
            .overlay { Editor(editing: editing).padding(.trailing, editing.aside * 2) }
    }

    private var marks: [PlacesMap.Mark] {
        let take = editing.take
        var seen = Set<String>()
        let places = editing.others.compactMap { other in seen.insert(other.slug).inserted ? editing.place(other.slug) : nil }.flatMap { place in
            let overlaps = take.overlaps.contains(place.name)
            return PlacesMap.Mark.places(place, reach: overlaps, back: true).map { mark in
                var mark = mark
                mark.quiet = overlaps
                return mark
            }
        }
        let stays = editing.points.map { point in
            PlacesMap.Mark(id: "stay:\(point.centre.latitude),\(point.centre.longitude)", kind: .stay, centre: point.centre,
                           lit: editing.taken(point))
        }
        let circles = editing.rows.filter { !$0.selected }.map { row in
            var mark = PlacesMap.Mark(id: "circle:\(row.id)", kind: .stay, centre: row.circle.centre, reach: row.circle.radiusMeters)
            mark.quiet = true
            return mark
        }
        return stays + places + circles
    }

    private struct Editor: View {
        let editing: CircleEditing

        var body: some View {
            CircleEditor(radius: Binding(get: { editing.radius }, set: { editing.resize($0) }),
                         limits: PlaceReach.smallest...PlaceReach.largest, snap: PlaceReach.snap, notch: PlaceReach.notch,
                         ticks: PlaceReach.ticks, metresPerPoint: editing.metresPerPoint, lifted: editing.lifted,
                         moved: editing.moved, words: PlaceReach.words, nudge: editing.nudge, held: editing.hold)
        }
    }
}

struct CircleSheetHead<Rows: View>: View {
    let editing: CircleEditing
    let identifier: String
    @ViewBuilder let rows: Rows
    @Environment(\.dynamicTypeSize) private var typeSize

    static var mapHeight: CGFloat { 300 }
    static var aside: CGFloat { 60 }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            CircleEdit(editing: editing)
                .frame(height: Self.mapHeight)
                .clipShape(RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous))
                .circleReach { CircleReach(editing: editing, identifier: "\(identifier).reach") }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Place map")
                .accessibilityIdentifier("\(identifier).map")
                .padding(.horizontal, Cockpit.Gap.sheet)
                .padding(.top, Cockpit.Gap.head)
            VStack(alignment: .leading, spacing: Cockpit.Space.s6) {
                if typeSize.isAccessibilitySize { CircleReach(editing: editing, identifier: "\(identifier).reach") }
                rows
            }
            .padding(.horizontal, Cockpit.Gap.sheet)
            .padding(.top, Cockpit.Space.s6)
            .padding(.bottom, Cockpit.Space.s8)
        }
    }
}

struct CircleReach: View {
    let editing: CircleEditing
    let identifier: String
    @StateObject private var haptics = PlaceHaptics()

    var body: some View {
        ValueStepper("Reach", value: radius, notch: { at, way in
            let next = PlaceReach.notch(at, way)
            return next == at ? nil : next
        }, less: "Smaller", more: "Larger") { PlaceReach.words($0) }
            .accessibilityIdentifier(identifier)
            .onAppear { haptics.prepare() }
    }

    private var radius: Binding<Double> {
        Binding(get: { editing.radius }, set: { metres in
            if metres == PlaceReach.smallest || metres == PlaceReach.largest { haptics.place() } else { haptics.tick() }
            editing.resize(metres)
        })
    }
}

@MainActor
final class PlaceHaptics: ObservableObject {
    private let selection = UISelectionFeedbackGenerator()
    private let soft = UIImpactFeedbackGenerator(style: .soft)
    private let notification = UINotificationFeedbackGenerator()
    private var lastTick: TimeInterval = 0

    func prepare() {
        selection.prepare()
        soft.prepare()
        notification.prepare()
    }

    func tap() { soft.impactOccurred(intensity: 0.55); prepare() }
    func place() { soft.impactOccurred(intensity: 0.85); prepare() }
    func tick() {
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastTick >= 0.045 else { return }
        lastTick = now
        selection.selectionChanged()
        selection.prepare()
    }
    func success() { notification.notificationOccurred(.success) }
    func warning() { notification.notificationOccurred(.warning) }
    func error() { notification.notificationOccurred(.error) }
}

private struct CircleMap: UIViewRepresentable {
    let editing: CircleEditing
    let marks: [PlacesMap.Mark]
    let flight: CircleEditing.Flight

    func makeUIView(context: Context) -> CircleMapView {
        let map = CircleMapView()
        map.isRotateEnabled = false
        map.layoutMargins = .zero
        map.aside = editing.aside
        map.delegate = context.coordinator
        map.landed = { [weak coordinator = context.coordinator] in coordinator?.editing.landed() }
        map.leaving = { [weak coordinator = context.coordinator, weak map] in
            guard let coordinator else { return }
            map?.undoManager?.removeAllActions(withTarget: coordinator.editing)
        }
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
        tap.delegate = context.coordinator
        map.addGestureRecognizer(tap)
        return map
    }

    func updateUIView(_ map: CircleMapView, context: Context) {
        context.coordinator.editing = editing
        editing.history = map
        context.coordinator.layer.draw(marks, on: map)
        if flight.id != context.coordinator.flown {
            context.coordinator.flown = flight.id
            DispatchQueue.main.async { map.fly(flight) }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(editing: editing) }

    @MainActor final class Coordinator: NSObject, MKMapViewDelegate, UIGestureRecognizerDelegate {
        var editing: CircleEditing
        let layer = MarkLayer()
        var flown = -1
        private var ours = false
        private var moving = false

        init(editing: CircleEditing) {
            self.editing = editing
        }

        func mapView(_ map: MKMapView, viewFor annotation: any MKAnnotation) -> MKAnnotationView? {
            let view = layer.view(for: annotation, on: map)
            view?.isEnabled = false
            return view
        }

        @objc func tapped(_ tap: UITapGestureRecognizer) {
            guard tap.state == .ended, let map = tap.view as? MKMapView else { return }
            editing.select(at: PlaceCoordinate(map.convert(tap.location(in: map), toCoordinateFrom: map)))
        }

        func gestureRecognizer(_ tap: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool { !editing.lifted }

        func gestureRecognizer(_ tap: UIGestureRecognizer, shouldRequireFailureOf other: UIGestureRecognizer) -> Bool {
            (other as? UITapGestureRecognizer).map { $0.numberOfTapsRequired > 1 } ?? false
        }

        func gestureRecognizer(_ tap: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        func mapViewDidFinishRenderingMap(_ map: MKMapView, fullyRendered: Bool) {
            if fullyRendered { (map as? FocusingMapView)?.reveal() }
        }

        func mapView(_ map: MKMapView, regionWillChangeAnimated animated: Bool) {
            guard let map = map as? CircleMapView else { return }
            if map.steering {
                ours = true
                return
            }
            guard map.flew, !moving else { return }
            moving = true
            editing.lift()
        }

        func mapViewDidChangeVisibleRegion(_ map: MKMapView) {
            layer.fit(on: map)
            report(map)
            if moving, let map = map as? CircleMapView { editing.move(to: PlaceCoordinate(map.pin)) }
        }

        func mapView(_ map: MKMapView, regionDidChangeAnimated animated: Bool) {
            report(map)
            if ours {
                ours = false
                editing.landed()
                return
            }
            guard moving else { return }
            moving = false
            if let map = map as? CircleMapView { editing.move(to: PlaceCoordinate(map.pin)) }
            editing.set()
        }

        private func report(_ map: MKMapView) {
            guard map.bounds.width > 0 else { return }
            let perPoint = map.visibleMapRect.width / map.bounds.width / MKMapPointsPerMeterAtLatitude(map.centerCoordinate.latitude)
            editing.scale(perPoint, side: min(map.bounds.width - editing.aside * 2, map.bounds.height))
        }
    }
}

final class CircleMapView: FocusingMapView {
    var aside: CGFloat = 0
    var pin: CLLocationCoordinate2D {
        convert(CGPoint(x: bounds.midX - aside, y: bounds.midY), toCoordinateFrom: self)
    }
    private var pending: CircleEditing.Flight?
    private(set) var steering = false
    private(set) var flew = false
    var landed: () -> Void = {}
    var leaving: () -> Void = {}

    override var canBecomeFirstResponder: Bool { true }

    override var keyCommands: [UIKeyCommand]? {
        let undo = UIKeyCommand(title: "Undo", action: #selector(undoChange), input: "z", modifierFlags: .command)
        let redo = UIKeyCommand(title: "Redo", action: #selector(redoChange), input: "z", modifierFlags: [.command, .shift])
        for key in [undo, redo] { key.wantsPriorityOverSystemBehavior = true }
        return [undo, redo]
    }

    @objc private func undoChange() { undoManager?.undo() }
    @objc private func redoChange() { undoManager?.redo() }

    override func willMove(toWindow window: UIWindow?) {
        if window == nil { leaving() }
        super.willMove(toWindow: window)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { becomeFirstResponder() }
    }

    func fly(_ flight: CircleEditing.Flight) {
        pending = flight
        if bounds.width > 0, bounds.height > 0 { land() }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if pending != nil, bounds.width > 0, bounds.height > 0 { land() }
    }

    private func land() {
        guard let flight = pending else { return }
        pending = nil
        let animated = flight.animated && UIView.areAnimationsEnabled && !UIAccessibility.isReduceMotionEnabled
        steering = true
        if let radius = flight.fit {
            let middle = MKMapPoint(flight.centre.clLocation)
            let perPoint = radius / (CircleEditing.fitted * min(bounds.width - aside * 2, bounds.height))
                * MKMapPointsPerMeterAtLatitude(flight.centre.latitude)
            let width = bounds.width * perPoint, height = bounds.height * perPoint
            setVisibleMapRect(MKMapRect(x: middle.x - width / 2 + aside * perPoint, y: middle.y - height / 2, width: width, height: height), animated: animated)
        } else {
            let point = MKMapPoint(flight.centre.clLocation)
            let across = aside * visibleMapRect.width / max(bounds.width, 1)
            setCenter(MKMapPoint(x: point.x + across, y: point.y).coordinate, animated: animated)
        }
        steering = false
        flew = true
        if !animated { landed() }
    }
}

extension PlaceCoordinate {
    init(_ point: CLLocationCoordinate2D) {
        self.init(latitude: point.latitude, longitude: point.longitude)
    }
}
