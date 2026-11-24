import Combine
import SwiftUI
import UIKit

enum CheckInRailSteps {
    static func value(at x: CGFloat, width: CGFloat, values: Range<Int>,
                      previous: Int?, rightToLeft: Bool = false) -> Int? {
        guard width.isFinite, width > 0, x.isFinite, !values.isEmpty else { return nil }
        let position = min(width, max(0, rightToLeft ? width - x : x))
        let cellWidth = width / CGFloat(values.count)
        if let previous, values.contains(previous) {
            let index = CGFloat(previous - values.lowerBound)
            let tolerance = min(3, cellWidth * 0.1)
            if position >= index * cellWidth - tolerance,
               position <= (index + 1) * cellWidth + tolerance { return previous }
        }
        return values.lowerBound + min(values.count - 1, Int(position / cellWidth))
    }

    static func isHorizontal(_ translation: CGPoint) -> Bool {
        abs(translation.x) > abs(translation.y)
    }

    struct Feedback: Equatable { let intensity: CGFloat }
    static func feedback(from previous: Int?, to next: Int, values: Range<Int>) -> Feedback? {
        guard values.contains(next), previous != next else { return nil }
        let position = CGFloat(next - values.lowerBound) / CGFloat(max(1, values.count - 1))
        return Feedback(intensity: 0.2 + 0.8 * position)
    }
}

@MainActor
final class CheckInRailHaptics: ObservableObject {
    private let impact = UIImpactFeedbackGenerator(style: .rigid)

    func prepare() {
        impact.prepare()
    }

    func play(_ feedback: CheckInRailSteps.Feedback) {
        impact.impactOccurred(intensity: feedback.intensity)
        prepare()
    }
}

struct CheckInRailScrubGesture: UIGestureRecognizerRepresentable {
    var prepare: () -> Void
    var changed: (CGPoint) -> Void
    var ended: () -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> RailPanRecognizer {
        let pan = RailPanRecognizer()
        pan.maximumNumberOfTouches = 1
        pan.delegate = context.coordinator
        pan.prepare = prepare
        return pan
    }

    func updateUIGestureRecognizer(_ recognizer: RailPanRecognizer, context: Context) {
        recognizer.prepare = prepare
    }

    func handleUIGestureRecognizerAction(_ recognizer: RailPanRecognizer, context: Context) {
        switch recognizer.state {
        case .began, .changed: changed(context.converter.localLocation)
        case .ended:
            changed(context.converter.localLocation)
            ended()
        case .cancelled, .failed: ended()
        default: break
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
            return CheckInRailSteps.isHorizontal(pan.translation(in: pan.view))
        }
    }

    final class RailPanRecognizer: UIPanGestureRecognizer {
        var prepare: (() -> Void)?
        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            prepare?()
            super.touchesBegan(touches, with: event)
        }
    }
}
