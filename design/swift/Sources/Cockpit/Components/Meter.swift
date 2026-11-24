import SwiftUI

public struct Meter: View {
    @Environment(\.cockpitPlatform) private var platform
    let label: String
    let value: String
    let share: Double
    let step: Int
    let progress: Bool

    public init(_ label: String, value: String, share: Double, step: Int = 1, progress: Bool = false) {
        self.label = label
        self.value = value
        self.share = share
        self.step = step
        self.progress = progress
    }

    private var fill: Color {
        if progress { return Cockpit.Color.here }
        if platform == .ios { return Cockpit.Color.data3 }
        return switch step {
        case ...1: Cockpit.Color.life
        case 2: Cockpit.Color.data2
        case 3: Cockpit.Color.data3
        default: Cockpit.Color.data4
        }
    }

    public var body: some View {
        let phone = platform == .ios
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s3) {
                Text(label).cockpit(phone ? .body : .subhead).foregroundStyle(Cockpit.Color.text).lineLimit(1)
                Spacer(minLength: 0)
                Text(value).cockpit(phone ? .subhead : .monoData).monospacedDigit().foregroundStyle(Cockpit.Color.textSecondary).lineLimit(1).fixedSize()
            }
            let bar = RoundedRectangle(cornerRadius: Cockpit.Radius.s2xs, style: .continuous)
            bar.fill(Cockpit.Color.track)
                .frame(height: phone ? 3 : 4)
                .overlay(alignment: .leading) {
                    GeometryReader { proxy in
                        let clamped = min(1, max(0, share))
                        bar.fill(fill).frame(width: clamped > 0 ? max(4, proxy.size.width * clamped) : 0)
                    }
                }
        }
        .padding(.vertical, phone ? 11 : 0)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(value)
    }
}
