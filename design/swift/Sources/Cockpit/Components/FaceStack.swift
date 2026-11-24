import SwiftUI

public struct FaceStack: View {
    public struct Face {
        let name: String?
        let photo: Image?

        public init(_ name: String?, photo: Image? = nil) {
            self.name = name
            self.photo = photo
        }
    }

    let faces: [Face]
    let limit: Int

    public init(_ faces: [Face], limit: Int = 3) {
        self.faces = faces
        self.limit = max(1, limit)
    }

    public init(names: [String?], limit: Int = 3) {
        self.init(names.map { Face($0) }, limit: limit)
    }

    public static func width(limit: Int = 3) -> CGFloat { side + CGFloat(max(1, limit) - 1) * step }

    private static var side: CGFloat { Cockpit.Size.avatarSm }
    private static var step: CGFloat { side - 4 }
    private static let cut: CGFloat = 1.5

    public var body: some View {
        if !faces.isEmpty {
            let more = faces.count > limit ? faces.count - (limit - 1) : 0
            let shown = more > 0 ? Array(faces.prefix(limit - 1)) : faces
            let count = shown.count + (more > 0 ? 1 : 0)
            ZStack(alignment: .leading) {
                ForEach(0..<count, id: \.self) { index in
                    if index > 0 {
                        Circle()
                            .frame(width: Self.side + 2 * Self.cut, height: Self.side + 2 * Self.cut)
                            .offset(x: CGFloat(index) * Self.step - Self.cut)
                            .blendMode(.destinationOut)
                    }
                    Group {
                        if index < shown.count {
                            PersonFace(shown[index].name, photo: shown[index].photo, size: .sm)
                        } else {
                            Circle()
                                .fill(Cockpit.Color.raised)
                                .overlay(Circle().strokeBorder(Cockpit.Color.border, lineWidth: Cockpit.Stroke.border))
                                .overlay {
                                    Text("+\(more)")
                                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                                        .minimumScaleFactor(0.7)
                                        .lineLimit(1)
                                        .foregroundStyle(Cockpit.Color.textSecondary)
                                }
                                .frame(width: Self.side, height: Self.side)
                        }
                    }
                    .offset(x: CGFloat(index) * Self.step)
                }
            }
            .frame(width: Self.side + CGFloat(count - 1) * Self.step, height: Self.side, alignment: .leading)
            .compositingGroup()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Self.words(shown.map { $0.name ?? "No name yet" }, more: more))
        }
    }

    static func words(_ names: [String], more: Int) -> String {
        let all = names + (more > 0 ? ["\(more) more"] : [])
        guard let last = all.last else { return "" }
        return all.count == 1 ? last : all.dropLast().joined(separator: ", ") + " and " + last
    }
}
