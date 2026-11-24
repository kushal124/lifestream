import SwiftUI

public struct Spinner: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var forced: Double?

    public init() {}

    init(forced: Double) { self.forced = forced }

    public var body: some View {
        let size = Cockpit.Size.iconSm
        TimelineView(.animation(paused: forced != nil)) { context in
            let seconds = context.date.timeIntervalSinceReferenceDate
            let turn = forced ?? (seconds / 0.9).truncatingRemainder(dividingBy: 1)
            let breath = 0.7 + 0.3 * cos(seconds * 2 * .pi / Cockpit.Duration.breath)
            ZStack {
                Circle().stroke(.foreground.opacity(0.22), lineWidth: 2)
                Circle().trim(from: 0, to: 0.25).stroke(.foreground, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(reduceMotion ? -90 : turn * 360 - 90))
            }
            .padding(1)
            .opacity(reduceMotion && forced == nil ? breath : 1)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
