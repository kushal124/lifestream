import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

public extension View {
    func leadingDrawer(isPresented: Binding<Bool>, fromEdge: Bool = false, @ViewBuilder drawer: () -> some View) -> some View {
        modifier(LeadingDrawer(open: isPresented, fromEdge: fromEdge, drawer: drawer()))
    }
}

private struct LeadingDrawer<Drawer: View>: ViewModifier {
    @Binding var open: Bool
    let fromEdge: Bool
    let drawer: Drawer
    @State private var drag: CGFloat?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let width = Cockpit.Size.drawer
    private let edge = Cockpit.Space.s5

    private var shown: CGFloat {
        min(width, max(0, (open ? width : 0) + (drag ?? 0)))
    }

    func body(content: Content) -> some View {
        let shown = shown
        ZStack(alignment: .topLeading) {
            content
                .offset(x: shown)
                .accessibilityHidden(open)
                .overlay {
                    if shown > 0 {
                        Cockpit.Color.scrim
                            .opacity(Double(shown / width))
                            .offset(x: shown)
                            .ignoresSafeArea()
                            .onTapGesture { settle(false) }
                            .gesture(closing)
                            .accessibilityHidden(true)
                    }
                }
                .overlay(alignment: .leading) {
                    if fromEdge && !open {
                        Color.clear
                            .frame(width: edge)
                            .contentShape(Rectangle())
                            .gesture(opening)
                            .ignoresSafeArea()
                            .accessibilityHidden(true)
                    }
                }
            if shown > 0 || open {
                drawer
                    .frame(width: width)
                    .frame(maxHeight: .infinity, alignment: .top)
                    .background {
                        Cockpit.Color.canvas
                            .overlay(alignment: .trailing) {
                                Rectangle().fill(Cockpit.Color.hairline).frame(width: Cockpit.Stroke.hairline)
                            }
                            .ignoresSafeArea()
                    }
                    .offset(x: shown - width)
                    .gesture(closing)
                    .accessibilityAddTraits(.isModal)
                    .accessibilityAction(.escape) { settle(false) }
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: Cockpit.Duration.fast) : .smooth(duration: Cockpit.Duration.base),
                   value: open)
        .onChange(of: open, initial: true) { _, isOpen in
            if isOpen { Self.endEditing() }
        }
    }

    private static func endEditing() {
        #if canImport(UIKit)
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        #endif
    }

    private var opening: some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged {
                if drag == nil { Self.endEditing() }
                drag = max(0, $0.translation.width)
            }
            .onEnded { settle($0.predictedEndTranslation.width > width / 2) }
    }

    private var closing: some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { drag = min(0, $0.translation.width) }
            .onEnded { settle(!($0.predictedEndTranslation.width < -width / 2)) }
    }

    private func settle(_ isOpen: Bool) {
        withAnimation(reduceMotion ? .easeInOut(duration: Cockpit.Duration.fast) : .smooth(duration: Cockpit.Duration.base)) {
            drag = nil
            open = isOpen
        }
    }
}
