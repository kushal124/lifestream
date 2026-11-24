import SwiftUI

public extension View {
    func pageFoot(lettingKeyboardGo focus: FocusState<Bool>.Binding? = nil, @ViewBuilder _ foot: () -> some View) -> some View {
        modifier(PageFoot(foot: foot(), focus: focus))
    }

    func floatingPill() -> some View {
        modifier(FloatingPill())
    }
}

private struct PageFoot<Foot: View>: ViewModifier {
    let foot: Foot
    let focus: FocusState<Bool>.Binding?
    @State private var footTop = CGFloat.infinity

    func body(content: Content) -> some View {
        #if os(iOS)
        let page = content
            .safeAreaBar(edge: .bottom, spacing: 0) {
                foot.onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { footTop = $0 }
            }
            .scrollEdgeEffectStyle(.soft, for: .bottom)
        if let focus {
            page.gesture(SwipeKeyboardAway(from: footTop - Cockpit.Space.s16) {
                focus.wrappedValue = false
                KeyboardAway.now()
            })
        } else {
            page
        }
        #else
        content.safeAreaInset(edge: .bottom, spacing: 0) { foot }
        #endif
    }
}

#if os(iOS)
private struct SwipeKeyboardAway: UIGestureRecognizerRepresentable {
    let from: CGFloat
    let away: () -> Void

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.cancelsTouchesInView = false
        pan.delegate = context.coordinator
        return pan
    }

    func handleUIGestureRecognizerAction(_ pan: UIPanGestureRecognizer, context: Context) {
        let moved = pan.translation(in: nil)
        switch pan.state {
        case .began:
            context.coordinator.near = pan.location(in: nil).y - moved.y >= from
            context.coordinator.gone = false
        case .changed where context.coordinator.near && !context.coordinator.gone:
            guard moved.y >= Cockpit.Space.s3, moved.y > abs(moved.x) else { return }
            context.coordinator.gone = true
            away()
        default:
            return
        }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var near = false
        var gone = false

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }
}
#endif

private struct FloatingPill: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.leading, Cockpit.Space.s4)
            .padding(.trailing, Cockpit.Space.s2)
            .padding(.vertical, Cockpit.Space.s2)
            .background { Color.clear.cockpitGlass(in: Capsule(), interactive: false) }
            .padding(.bottom, Cockpit.Space.s3)
    }
}
