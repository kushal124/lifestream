import QuartzCore
import SwiftUI

public struct BreathRing: View {
    let color: Color
    let scale: CGFloat
    let from: Double
    let filled: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.breathForced) private var forced

    public init(color: Color, scale: CGFloat, from: Double, filled: Bool = false) {
        self.color = color
        self.scale = scale
        self.from = from
        self.filled = filled
    }

    public var body: some View {
        if reduceMotion {
            EmptyView()
        } else if let forced {
            let eased = 1 - pow(1 - min(1, forced / 0.7), 3)
            Group {
                if filled { Circle().fill(color) } else { Circle().stroke(color, lineWidth: Cockpit.Stroke.line) }
            }
            .scaleEffect(1 + (scale - 1) * eased)
            .opacity(from * (1 - eased))
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        } else {
            BreathLayer(color: color, scale: scale, from: from, filled: filled, active: scenePhase == .active)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }
}

extension EnvironmentValues {
    @Entry var breathForced: Double?
}

#if canImport(UIKit)
private typealias PlatformView = UIView
private typealias Representable = UIViewRepresentable
#else
private typealias PlatformView = NSView
private typealias Representable = NSViewRepresentable
#endif

private struct BreathLayer: Representable {
    let color: Color
    let scale: CGFloat
    let from: Double
    let filled: Bool
    let active: Bool

    #if canImport(UIKit)
    func makeUIView(context: Context) -> BreathView { BreathView() }
    func updateUIView(_ view: BreathView, context: Context) { update(view, context.environment) }
    #else
    func makeNSView(context: Context) -> BreathView { BreathView() }
    func updateNSView(_ view: BreathView, context: Context) { update(view, context.environment) }
    #endif

    private func update(_ view: BreathView, _ environment: EnvironmentValues) {
        let ink = color.resolve(in: environment).cgColor
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        view.ring.fillColor = filled ? ink : nil
        view.ring.strokeColor = filled ? nil : ink
        view.ring.lineWidth = Cockpit.Stroke.line
        CATransaction.commit()
        if view.scale != scale || view.from != from || view.active != active {
            (view.scale, view.from, view.active) = (scale, from, active)
            view.breathe()
        }
    }
}

private final class BreathView: PlatformView {
    let ring = CAShapeLayer()
    var scale: CGFloat = 1
    var from: Double = 0
    var active = false

    init() {
        super.init(frame: .zero)
        #if canImport(UIKit)
        isUserInteractionEnabled = false
        layer.addSublayer(ring)
        #else
        wantsLayer = true
        layer?.addSublayer(ring)
        #endif
        ring.opacity = 0
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a coder") }

    #if canImport(UIKit)
    override func layoutSubviews() {
        super.layoutSubviews()
        place()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        breathe()
    }
    #else
    override var isFlipped: Bool { true }

    override func layout() {
        super.layout()
        place()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        breathe()
    }
    #endif

    private func place() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ring.frame = bounds
        ring.path = CGPath(ellipseIn: CGRect(origin: .zero, size: bounds.size), transform: nil)
        CATransaction.commit()
    }

    func breathe() {
        ring.removeAllAnimations()
        guard window != nil, active else { return }
        let grow = CAKeyframeAnimation(keyPath: "transform.scale")
        grow.values = [1, scale, scale]
        let fade = CAKeyframeAnimation(keyPath: "opacity")
        fade.values = [from, 0, 0]
        for part in [grow, fade] {
            part.keyTimes = [0, 0.7, 1]
            part.timingFunctions = [CAMediaTimingFunction(controlPoints: 0.33, 1, 0.68, 1), CAMediaTimingFunction(name: .linear)]
        }
        let breath = CAAnimationGroup()
        breath.animations = [grow, fade]
        breath.duration = Cockpit.Duration.breath
        breath.repeatCount = .infinity
        let now = CACurrentMediaTime()
        let phase = now.truncatingRemainder(dividingBy: Cockpit.Duration.breath)
        breath.beginTime = ring.convertTime(now - phase, from: nil)
        ring.add(breath, forKey: "breath")
    }
}
