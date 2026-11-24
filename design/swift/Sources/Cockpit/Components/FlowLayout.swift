import SwiftUI

public struct FlowLayout: Layout {
    var spacing: CGFloat
    var lineSpacing: CGFloat
    var centred = false

    public init(spacing: CGFloat, lineSpacing: CGFloat, centred: Bool = false) {
        self.spacing = spacing
        self.lineSpacing = lineSpacing
        self.centred = centred
    }

    public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let lines = arrange(subviews, width: proposal.width ?? .infinity)
        let width = lines.map { $0.width }.max() ?? 0
        let height = lines.reduce(0) { $0 + $1.height } + lineSpacing * CGFloat(max(0, lines.count - 1))
        return CGSize(width: proposal.width.map { centred ? $0 : min($0, width) } ?? width, height: height)
    }

    public func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for line in arrange(subviews, width: bounds.width) {
            var x = centred ? bounds.midX - line.width / 2 : bounds.minX
            for (index, size) in zip(line.indices, line.sizes) {
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += line.height + lineSpacing
        }
    }

    private struct Line { var indices: [Int] = []; var sizes: [CGSize] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> [Line] {
        var lines: [Line] = [Line()]
        for (index, subview) in subviews.enumerated() {
            var size = subview.sizeThatFits(.unspecified)
            if size.width > width { size = subview.sizeThatFits(ProposedViewSize(width: width, height: nil)) }
            let needed = lines[lines.count - 1].indices.isEmpty ? size.width : lines[lines.count - 1].width + spacing + size.width
            if needed > width, !lines[lines.count - 1].indices.isEmpty {
                lines.append(Line())
            }
            var line = lines[lines.count - 1]
            line.width = line.indices.isEmpty ? size.width : line.width + spacing + size.width
            line.height = max(line.height, size.height)
            line.indices.append(index)
            line.sizes.append(size)
            lines[lines.count - 1] = line
        }
        return lines.filter { !$0.indices.isEmpty }
    }
}
