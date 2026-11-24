import SwiftUI

public struct Tick: View {
    let on: Bool
    let photo: Bool
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.redactionReasons) private var redaction
    @Environment(\.skeletonTone) private var tone
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(on: Bool, photo: Bool = false) {
        self.on = on
        self.photo = photo
    }

    static func side(_ platform: Cockpit.Platform) -> CGFloat { platform == .ios ? 22 : 18 }

    private var side: CGFloat { Self.side(platform) + (photo ? 2 : 0) }

    public var body: some View {
        ZStack {
            if redaction.skeleton {
                Circle().fill(tone)
            } else {
                Circle().fill(on ? Cockpit.Color.here : photo ? Cockpit.Color.photoScrim : Color.clear)
                if photo || !on {
                    Circle().strokeBorder(photo ? Cockpit.Color.knob : Cockpit.Color.strokeControl, lineWidth: 1.5)
                }
                Check()
                    .stroke(Cockpit.Color.textInverse, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    .opacity(on ? 1 : 0)
            }
        }
        .frame(width: side, height: side)
        .animation(reduceMotion ? nil : .easeOut(duration: Cockpit.Duration.instant), value: on)
        .accessibilityHidden(true)
    }

    private struct Check: Shape {
        func path(in rect: CGRect) -> Path {
            let unit = rect.width / 20
            var path = Path()
            path.move(to: CGPoint(x: 6.2 * unit, y: 10.4 * unit))
            path.addLine(to: CGPoint(x: 8.9 * unit, y: 13 * unit))
            path.addLine(to: CGPoint(x: 13.8 * unit, y: 7.4 * unit))
            return path
        }
    }
}
