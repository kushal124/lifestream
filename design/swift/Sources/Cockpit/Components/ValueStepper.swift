import SwiftUI

public struct ValueStepper<Value: Hashable>: View {
    let label: String
    @Binding var value: Value
    let move: (Value, Int) -> Value?
    let words: (Value) -> String
    let less: String
    let more: String
    @Environment(\.cockpitPlatform) private var platform

    public init(_ label: String, value: Binding<Value>, steps: [Value], less: String = "Less", more: String = "More",
                words: @escaping (Value) -> String) {
        self.label = label
        self._value = value
        self.move = { at, way in
            let next = (steps.firstIndex(of: at) ?? 0) + way
            return steps.indices.contains(next) ? steps[next] : nil
        }
        self.less = less
        self.more = more
        self.words = words
    }

    public init(_ label: String, value: Binding<Value>, notch: @escaping (Value, Int) -> Value?, less: String = "Less",
                more: String = "More", words: @escaping (Value) -> String) {
        self.label = label
        self._value = value
        self.move = notch
        self.less = less
        self.more = more
        self.words = words
    }

    public var body: some View {
        #if os(iOS)
        HStack(spacing: Cockpit.Space.s3) {
            Text(words(value))
                .cockpit(.body)
                .monospacedDigit()
                .foregroundStyle(Cockpit.Color.textSecondary)
                .lineLimit(1)
                .fixedSize()
            Stepper(label, onIncrement: move(value, 1) == nil ? nil : { step(1) }, onDecrement: move(value, -1) == nil ? nil : { step(-1) })
                .labelsHidden()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(words(value))
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: step(1)
            case .decrement: step(-1)
            @unknown default: break
            }
        }
        #else
        drawn
        #endif
    }

    private var drawn: some View {
        HStack(spacing: 0) {
            side(-1, .back, less)
            Text(words(value))
                .cockpit(.monoData)
                .monospacedDigit()
                .foregroundStyle(Cockpit.Color.text)
                .lineLimit(1)
                .frame(minWidth: 44)
                .padding(.horizontal, Cockpit.Space.s1)
            side(1, .forward, more)
        }
        .padding(Self.inset)
        .frame(height: platform.controlHeight)
        .background(RoundedRectangle(cornerRadius: platform == .ios ? platform.controlHeight / 2 : Cockpit.Radius.control, style: .continuous)
            .fill(Cockpit.Color.raised))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(words(value))
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: step(1)
            case .decrement: step(-1)
            @unknown default: break
            }
        }
    }

    private static var inset: CGFloat { 2 }
    private func step(_ way: Int) {
        if let next = move(value, way) { value = next }
    }

    private func side(_ way: Int, _ meaning: Cockpit.Icon, _ said: String) -> some View {
        let shape = RoundedRectangle(cornerRadius: (platform == .ios ? platform.controlHeight / 2 : Cockpit.Radius.control) - Self.inset, style: .continuous)
        let end = move(value, way) == nil
        return Button { step(way) } label: {
            Icon(meaning, size: platform == .ios ? .md : .sm, label: said)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .frame(width: platform.controlHeight - Self.inset * 2)
                .frame(maxHeight: .infinity)
                .contentShape(shape)
        }
        .buttonStyle(.plain)
        .disabled(end)
        .opacity(end ? Cockpit.Opacity.disabled : 1)
    }
}
