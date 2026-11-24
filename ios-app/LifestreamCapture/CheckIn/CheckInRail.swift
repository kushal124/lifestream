import Cockpit
import LifestreamCaptureCore
import SwiftUI
import UIKit

struct CheckInRail: View {
    let item: CheckInItem
    @Binding var value: JSONValue?
    var onChange: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.layoutDirection) private var layoutDirection
    @StateObject private var haptics = CheckInRailHaptics()
    @State private var trackWidth: CGFloat = 0
    @State private var scrubbing = false

    private var selection: Int? {
        switch value {
        case .integer(let n): Int(n)
        case .bool(let b): b ? 2 : 1
        case .string(let s): item.labels.firstIndex { $0.lowercased() == s }.map { $0 + 1 }
        default: nil
        }
    }
    private var chosenWord: String {
        selection.flatMap { item.values.contains($0) ? item.labels[$0 - item.firstValue] : nil } ?? ""
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
            HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s3) {
                question
                Spacer(minLength: Cockpit.Space.s1)
                Text(chosenWord)
                    .cockpit(.subhead)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .lineLimit(1)
                    .accessibilityHidden(true)
            }
            track
                .padding(.horizontal, 6)
                .frame(height: Cockpit.Size.target)
                .background(Cockpit.Color.raised, in: Capsule())
            if item.format == .rating {
                HStack(alignment: .top, spacing: Cockpit.Space.s3) {
                    Text(item.id == "kss" ? "Extremely alert" : item.anchors[0])
                    Spacer(minLength: Cockpit.Space.s1)
                    Text(item.id == "kss" ? "Fighting sleep" : item.anchors[1]).multilineTextAlignment(.trailing)
                }
                .cockpit(.caption)
                .foregroundStyle(Cockpit.Color.textTertiary)
            }
        }
    }

    @ViewBuilder private var track: some View {
        if item.format == .rating {
            cells
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { trackWidth = $0 }
                .gesture(CheckInRailScrubGesture(prepare: haptics.prepare, changed: { point in
                    scrubbing = true
                    if let next = CheckInRailSteps.value(at: point.x, width: trackWidth, values: item.values,
                        previous: selection, rightToLeft: layoutDirection == .rightToLeft) {
                        select(next)
                    }
                }, ended: { scrubbing = false }))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(item.title)
                .accessibilityValue(selection.map { "\(chosenWord), \($0 - item.firstValue + 1) of \(item.scale)" } ?? "Not selected")
                .accessibilityAdjustableAction { direction in
                    let next: Int
                    switch direction {
                    case .increment: next = selection.map { $0 + 1 } ?? item.firstValue
                    case .decrement: next = selection.map { $0 - 1 } ?? item.values.upperBound - 1
                    @unknown default: return
                    }
                    select(next)
                }
                .accessibilityIdentifier("checkin.\(item.id).rail")
        } else {
            cells
        }
    }

    private var cells: some View {
        HStack(spacing: 0) {
            ForEach(Array(item.values), id: \.self) { number in
                let chosen = selection == number
                Button {
                    select(number)
                } label: {
                    ZStack {
                        if item.format == .category || item.format == .yesNo {
                            Capsule().fill(chosen ? Cockpit.Color.accentSolid : .clear).frame(height: 32)
                            CellWord(words: item.labels[number - item.firstValue], chosen: chosen)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                                .padding(.horizontal, Cockpit.Space.s1)
                        } else {
                            Circle().fill(chosen ? Cockpit.Color.accentSolid : .clear).frame(width: 32, height: 32)
                            CellWord(words: "\(number)", chosen: chosen)
                                .monospacedDigit()
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: Cockpit.Size.target)
                    .contentShape(Rectangle())
                }
                .buttonStyle(CheckInCellStyle(rating: item.format == .rating))
                .accessibilityLabel(item.labels[number - item.firstValue])
                .accessibilityValue("\(number - item.firstValue + 1) of \(item.scale)")
                .accessibilityAddTraits(selection == number ? .isSelected : [])
                .accessibilityIdentifier("checkin.\(item.id).\(number)")
            }
        }
    }

    private func select(_ number: Int) {
        guard let feedback = CheckInRailSteps.feedback(from: selection, to: number, values: item.values) else { return }
        if selection != nil { onChange() }
        withAnimation(reduceMotion || scrubbing ? nil : Cockpit.Ease.out(Cockpit.Duration.instant)) {
            switch item.format {
            case .yesNo: value = .bool(number == 2)
            case .category: value = .string(item.labels[number - item.firstValue].lowercased())
            default: value = .integer(Int64(number))
            }
        }
        haptics.play(item.format == .rating ? feedback : .init(intensity: 0.45))
    }
    private var question: some View {
        Text(item.title)
            .cockpit(.headline)
            .foregroundStyle(Cockpit.Color.text)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct CheckInCellStyle: ButtonStyle {
    let rating: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .environment(\.checkInCellHeld, configuration.isPressed)
            .background {
                if configuration.isPressed && !rating {
                    RoundedRectangle(cornerRadius: Cockpit.Radius.sm, style: .continuous).fill(Cockpit.Color.pressed)
                }
            }
    }
}

private struct CellWord: View {
    let words: String
    let chosen: Bool
    @Environment(\.checkInCellHeld) private var held

    var body: some View {
        Text(words)
            .cockpit(.subhead)
            .foregroundStyle(chosen ? Cockpit.Color.accentInk : held ? Cockpit.Color.text : Cockpit.Color.textSecondary)
    }
}

private extension EnvironmentValues {
    @Entry var checkInCellHeld = false
}
