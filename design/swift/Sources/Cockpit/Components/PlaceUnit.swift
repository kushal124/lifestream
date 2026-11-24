import SwiftUI

public struct PlaceUnit: View {
    let name: String
    let minutes: String
    let line: Arriving?
    let quiet: Bool
    let action: () -> Void
    var forced: RowHighlight?
    @Environment(\.dynamicTypeSize) private var typeSize

    public init(_ name: String, minutes: String, line: Arriving? = nil, quiet: Bool = false, action: @escaping () -> Void) {
        self.name = name
        self.quiet = quiet
        self.minutes = minutes
        self.line = line
        self.action = action
    }

    public var body: some View {
        let m = DayMeasure(size: typeSize)
        let first = line == nil ? m(31) : m(28)
        Button(action: action) {
            ZStack(alignment: .topLeading) {
                Color.clear.frame(height: line == nil ? m(52) : m(68))
                HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s4) {
                    Text(name)
                        .cockpit(Cockpit.Style.phoneRowTitle)
                        .foregroundStyle(quiet ? Cockpit.Color.textSecondary : Cockpit.Color.text)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(minutes)
                        .cockpit(Cockpit.Style.phoneRowTitle)
                        .monospacedDigit()
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .lineLimit(1)
                        .fixedSize()
                }
                .column(Cockpit.Gap.edge, trailing: Cockpit.Gap.edge)
                .onBaseline(first)
                if let line {
                    ArrivingText(line: line, style: Cockpit.Style.iosSubhead, tone: Cockpit.Color.textSecondary)
                        .lineLimit(1)
                        .column(Cockpit.Gap.edge, trailing: Cockpit.Gap.edge)
                        .onBaseline(first + m(20))
                }
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(DayPress(forced: forced))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Spoken.join(name, Spoken.read(minutes), line?.said))
        .accessibilityAddTraits(.isButton)
    }
}
