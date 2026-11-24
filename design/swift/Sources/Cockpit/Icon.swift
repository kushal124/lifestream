import SwiftUI

public extension Cockpit {
    enum PathOp: Sendable {
        case m(CGFloat, CGFloat)
        case l(CGFloat, CGFloat)
        case c(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)
        case z
    }

    enum IconSize: Sendable {
        case xs
        case sm
        case md
        case lg
        case xl

        public var points: CGFloat {
            switch self {
            case .xs: Size.iconXs
            case .sm: Size.iconSm
            case .md: Size.iconMd
            case .lg: Size.iconLg
            case .xl: Size.iconXl
            }
        }
    }
}

public struct Icon: View {
    public enum Weight: Sendable { case regular, fill }

    let meaning: Cockpit.Icon
    let weight: Weight
    let size: Cockpit.IconSize?
    let label: String?
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.cockpitIconSize) private var contextSize
    @Environment(\.redactionReasons) private var redaction

    public init(_ meaning: Cockpit.Icon, weight: Weight = .regular, size: Cockpit.IconSize? = nil, label: String? = nil) {
        self.meaning = meaning
        self.weight = weight
        self.size = size
        self.label = label
    }

    public var body: some View {
        let side = (size ?? contextSize)?.points ?? platform.iconSize
        Group {
            if redaction.skeleton {
                SkeletonIcon(side: side)
            } else {
                IconShape(meaning: meaning, weight: weight)
                    .fill(.foreground)
                    .frame(width: side, height: side)
            }
        }
            .accessibilityHidden(label == nil)
            .accessibilityLabel(label.map { Text($0) } ?? Text(""))
            .accessibilityAddTraits(.isImage)
    }
}

public struct IconShape: Shape {
    public let meaning: Cockpit.Icon
    public let weight: Icon.Weight

    public init(meaning: Cockpit.Icon, weight: Icon.Weight = .regular) {
        self.meaning = meaning
        self.weight = weight
    }

    public func path(in rect: CGRect) -> Path {
        let grid = Self.grid(meaning, weight)
        let scale = min(rect.width, rect.height) / 256
        return grid.applying(CGAffineTransform(translationX: rect.midX - 128 * scale, y: rect.midY - 128 * scale).scaledBy(x: scale, y: scale))
    }

    static func grid(_ meaning: Cockpit.Icon, _ weight: Icon.Weight) -> Path {
        switch meaning.drawing {
        case let .phosphor(regular, fill):
            return path(weight == .fill ? fill ?? regular : regular)
        case let .own(stroke, solid):
            let outline = path(stroke).strokedPath(StrokeStyle(lineWidth: 16, lineCap: .round, lineJoin: .round))
            guard weight == .fill, let solid else { return outline }
            return outline.union(path(solid))
        }
    }

    private static func path(_ ops: [Cockpit.PathOp]) -> Path {
        var path = Path()
        for op in ops {
            switch op {
            case let .m(x, y): path.move(to: CGPoint(x: x, y: y))
            case let .l(x, y): path.addLine(to: CGPoint(x: x, y: y))
            case let .c(x1, y1, x2, y2, x, y): path.addCurve(to: CGPoint(x: x, y: y), control1: CGPoint(x: x1, y: y1), control2: CGPoint(x: x2, y: y2))
            case .z: path.closeSubpath()
            }
        }
        return path
    }
}

private struct IconSizeKey: EnvironmentKey {
    static let defaultValue: Cockpit.IconSize? = nil
}

extension EnvironmentValues {
    var cockpitIconSize: Cockpit.IconSize? {
        get { self[IconSizeKey.self] }
        set { self[IconSizeKey.self] = newValue }
    }
}
