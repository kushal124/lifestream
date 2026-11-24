import SwiftUI

public struct FigureRow: View {
    public struct Value: Sendable, Hashable {
        public let value: String
        public let caption: String

        public init(_ value: String, _ caption: String) {
            self.value = value
            self.caption = caption
        }
    }

    public static let most = 3

    let figures: [Value]
    @Environment(\.dynamicTypeSize) private var typeSize

    public init(_ figures: [Value]) {
        self.figures = Array(figures.prefix(Self.most))
    }

    public var body: some View {
        if !figures.isEmpty {
            Group {
                if typeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 0) { cells }
                } else {
                    HStack(alignment: .top, spacing: 0) {
                        cells
                        ForEach(figures.count..<Self.most, id: \.self) { _ in Color.clear.frame(height: 0) }
                    }
                }
            }
            .padding(.horizontal, Cockpit.Gap.edge)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var cells: some View {
        let measure = DayMeasure(size: typeSize)
        let value = measure(22, .title2)
        let caption = value + measure(18, .caption)
        return ForEach(figures, id: \.self) { figure in
            ZStack(alignment: .topLeading) {
                Color.clear.frame(height: caption + measure(20, .caption))
                Text(figure.value)
                    .cockpit(Cockpit.Style.iosFigureL)
                    .foregroundStyle(Cockpit.Color.text)
                    .onBaseline(value)
                Text(figure.caption)
                    .cockpit(Cockpit.Style.iosCaption)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .onBaseline(caption)
            }
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("\(figure.value), \(figure.caption)"))
        }
    }
}
