import SwiftUI

public struct CircleEditor: View {
    @Binding var radius: Double
    let limits: ClosedRange<Double>
    let snap: (Double) -> Double
    let notch: (_ from: Double, _ way: Int) -> Double
    let ticks: (_ from: Double, _ to: Double) -> Bool
    let metresPerPoint: Double
    let lifted: Bool
    let moved: String
    let words: (Double) -> String
    let nudge: (Nudge) -> Void
    let held: (Bool) -> Void
    var forcedHeld = false

    @State private var drag: Drag?
    @State private var stretch: CGFloat = 0
    @State private var tick = 0
    @State private var bumps = 0
    @State private var atEnd = false
    @State private var nudged = false
    @State private var rescaled = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public enum Nudge: String, CaseIterable, Sendable {
        case north, south, east, west
    }

    private struct Drag {
        let radius: Double
        let distance: CGFloat
    }

    public static let knob: CGFloat = 24
    static let clearOfPin: CGFloat = 34
    static let head: CGFloat = 14
    static let rise: CGFloat = 12

    public init(radius: Binding<Double>, limits: ClosedRange<Double>, snap: @escaping (Double) -> Double,
                notch: @escaping (_ from: Double, _ way: Int) -> Double, ticks: @escaping (_ from: Double, _ to: Double) -> Bool, metresPerPoint: Double, lifted: Bool, moved: String,
                words: @escaping (Double) -> String, nudge: @escaping (Nudge) -> Void, held: @escaping (Bool) -> Void = { _ in }) {
        self._radius = radius
        self.limits = limits
        self.snap = snap
        self.notch = notch
        self.ticks = ticks
        self.metresPerPoint = metresPerPoint
        self.lifted = lifted
        self.moved = moved
        self.words = words
        self.nudge = nudge
        self.held = held
    }

    public var body: some View {
        GeometryReader { box in
            let size = box.size
            let middle = CGPoint(x: size.width / 2, y: size.height / 2)
            if metresPerPoint > 0, metresPerPoint.isFinite {
                let ring = min(CGFloat(radius / metresPerPoint), hypot(size.width, size.height))
                let reach = min(max(ring, Self.clearOfPin) + stretch, size.width / 2 - Self.knob / 2 - 4)
                let handle = CGPoint(x: middle.x + max(reach, Self.clearOfPin / 2), y: middle.y)
                ZStack {
                    Circle()
                        .fill(MapMarks.ink.opacity(0.07))
                        .overlay(Circle().strokeBorder(MapMarks.ink, lineWidth: Cockpit.Stroke.line))
                        .frame(width: ring * 2, height: ring * 2)
                        .position(middle)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                    if handle.x - middle.x > ring + 1 {
                        Path { path in
                            path.move(to: CGPoint(x: middle.x + ring, y: middle.y))
                            path.addLine(to: handle)
                        }
                        .stroke(MapMarks.ink, style: StrokeStyle(lineWidth: Cockpit.Stroke.border, dash: Cockpit.Dash.future))
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                    }
                    pin.position(middle)
                    knob(middle: middle).position(handle)
                    if holding {
                        label.position(x: min(max(handle.x, 40), size.width - 40), y: handle.y > 56 ? handle.y - 34 : handle.y + 34)
                            .transition(.opacity)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
            }
        }
        .coordinateSpace(.named(Self.space))
        .sensoryFeedback(.selection, trigger: tick)
        .sensoryFeedback(.impact(weight: .medium, intensity: 0.8), trigger: bumps)
        .sensoryFeedback(.impact(weight: .light, intensity: 0.6), trigger: lifted)
        .sensoryFeedback(.impact(weight: .light, intensity: 0.5), trigger: drag != nil)
        .onChange(of: metresPerPoint) { if drag != nil { rescaled = true } }
        .onChange(of: moved) { _, now in
            guard nudged else { return }
            nudged = false
            AccessibilityNotification.Announcement(now).post()
        }
    }

    private var holding: Bool { drag != nil || forcedHeld }


    private var pin: some View {
        let rise = lifted && !reduceMotion ? Self.rise : 0
        return ZStack {
            Ellipse()
                .fill(Color.black.opacity(lifted ? 0.28 : 0))
                .frame(width: 8, height: 3)
            Capsule()
                .fill(MapMarks.ink)
                .frame(width: 2, height: rise)
                .offset(y: -rise / 2)
            Circle()
                .fill(MapMarks.ink)
                .overlay(Circle().strokeBorder(Cockpit.Color.surface, lineWidth: Cockpit.Stroke.line))
                .frame(width: Self.head, height: Self.head)
                .scaleEffect(lifted && !reduceMotion ? 1.15 : 1)
                .offset(y: -rise)
        }
        .frame(width: Cockpit.Size.target, height: Cockpit.Size.target)
        .animation(reduceMotion ? nil : .spring(duration: 0.28, bounce: 0.35), value: lifted)
        .allowsHitTesting(false)
        .accessibilityElement()
        .accessibilityLabel("Center")
        .accessibilityValue(moved)
        .accessibilityHint("Move the map to move it.")
        .accessibilityActions {
            ForEach(Nudge.allCases, id: \.self) { way in
                Button("Move \(way.rawValue)") {
                    nudged = true
                    nudge(way)
                }
            }
        }
        .accessibilityIdentifier("circle.center")
    }


    private func knob(middle: CGPoint) -> some View {
        Circle()
            .fill(MapMarks.ink)
            .overlay(Circle().strokeBorder(Cockpit.Color.surface, lineWidth: Cockpit.Stroke.line))
            .cockpitShadow(Cockpit.Shadow.knob, in: Circle())
            .frame(width: Self.knob, height: Self.knob)
            .scaleEffect(holding && !reduceMotion ? 1.2 : 1)
            .animation(reduceMotion ? nil : .spring(duration: 0.2, bounce: 0.3), value: holding)
            .frame(width: Cockpit.Size.target, height: Cockpit.Size.target)
            .contentShape(Circle())
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .named(Self.space))
                    .onChanged { value in dragged(to: value.location, middle: middle) }
                    .onEnded { _ in let_go() }
            )
            .accessibilityElement()
            .accessibilityLabel("Size")
            .accessibilityValue(words(radius))
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: step(1)
                case .decrement: step(-1)
                @unknown default: break
                }
            }
            .accessibilityIdentifier("circle.size")
    }

    static let space = "circle-editor"

    private var label: some View {
        Text(words(radius))
            .cockpit(.monoData)
            .monospacedDigit()
            .foregroundStyle(Cockpit.Color.text)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, Cockpit.Space.s2)
            .padding(.vertical, Cockpit.Space.s1)
            .cockpitGlass(in: Capsule())
    }

    private func dragged(to location: CGPoint, middle: CGPoint) {
        let distance = hypot(location.x - middle.x, location.y - middle.y)
        if rescaled, drag != nil {
            rescaled = false
            drag = Drag(radius: radius, distance: distance)
        }
        let start = drag ?? Drag(radius: radius, distance: distance)
        if drag == nil {
            drag = start
            held(true)
        }
        let (low, high) = (limits.lowerBound, limits.upperBound)
        let wanted = start.radius + Double(distance - start.distance) * metresPerPoint
        let kept = min(high, max(low, wanted))
        let snapped = snap(kept)
        if snapped != radius {
            if ticks(radius, snapped) { tick += 1 }
            radius = snapped
        }
        let over = CGFloat((wanted - kept) / metresPerPoint)
        stretch = (over < 0 ? -1 : 1) * (1 - 1 / (abs(over) * 0.55 / 40 + 1)) * 40
        if over != 0, !atEnd { bumps += 1 }
        atEnd = over != 0
    }

    private func let_go() {
        drag = nil
        atEnd = false
        withAnimation(reduceMotion ? nil : .spring(duration: 0.3, bounce: 0.2)) { stretch = 0 }
        held(false)
    }

    private func step(_ way: Int) {
        let next = notch(radius, way)
        if next != radius { radius = next }
    }
}
