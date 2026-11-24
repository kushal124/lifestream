import SwiftUI

public struct PersonRow: View {
    @Environment(\.cockpitPlatform) private var platform
    let name: String
    let photo: Image?
    let runs: [ContactRun]
    let quiet: Bool
    let action: () -> Void
    var forced: RowHighlight?
    @Environment(\.dynamicTypeSize) private var typeSize

    public init(_ name: String, photo: Image? = nil, runs: [ContactRun], quiet: Bool = false, action: @escaping () -> Void) {
        self.name = name
        self.photo = photo
        self.runs = runs
        self.quiet = quiet
        self.action = action
    }

    public var body: some View {
        let m = DayMeasure(size: typeSize)
        Button(action: action) {
            HStack(spacing: Cockpit.Space.s4) {
                PersonFace(name, photo: photo, size: .row)
                HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s4) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(name)
                            .cockpit(Cockpit.Style.phoneRowTitle)
                            .foregroundStyle(quiet ? Cockpit.Color.textSecondary : Cockpit.Color.text)
                            .lineLimit(1)
                        if !line.isEmpty {
                            Text(line)
                                .cockpit(Cockpit.Style.iosSubhead)
                                .foregroundStyle(Cockpit.Color.textSecondary)
                                .lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    ContactRuns(runs: runs.prefix(1).map(\.counted), glyph: .sm, tone: Cockpit.Color.textSecondary, value: Cockpit.Style.phoneRowTitle)
                }
            }
            .padding(.horizontal, Cockpit.Gap.edge)
            .frame(maxWidth: .infinity, minHeight: m(line.isEmpty ? 52 : 68))
            .contentShape(Rectangle())
        }
        .buttonStyle(DayPress(forced: forced))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Spoken.join(name, runs.map(\.said).joined(separator: ", ")))
        .accessibilityAddTraits(.isButton)
    }

    private var line: String {
        let first = runs.first.map { $0.counted == $0 ? [] : [$0] } ?? []
        return (first + runs.dropFirst()).map(\.written).joined(separator: ", ")
    }
}
