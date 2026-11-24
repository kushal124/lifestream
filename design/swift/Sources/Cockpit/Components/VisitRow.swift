import SwiftUI

public struct VisitRow: View {
    let day: String
    let span: String
    let length: String
    let here: Bool
    let people: [FaceStack.Face]
    let faces: Bool
    let separator: Bool
    let action: () -> Void

    public init(day: String, span: String, length: String, here: Bool = false, people: [FaceStack.Face] = [], faces: Bool,
                separator: Bool = true, action: @escaping () -> Void) {
        self.day = day
        self.span = span
        self.length = length
        self.here = here
        self.people = people
        self.faces = faces
        self.separator = separator
        self.action = action
    }

    @Environment(\.dynamicTypeSize) private var typeSize

    public var body: some View {
        let large = typeSize.isAccessibilitySize
        ListRow(day, here: here, meta: large ? span + " · " + length : span, mono: true, value: large ? nil : length, chevron: true,
                separator: separator, action: action) {
            if large {
                FaceStack(people)
            } else if faces {
                ZStack(alignment: .trailing) {
                    Color.clear
                    FaceStack(people)
                }
                .frame(width: FaceStack.width(), height: Cockpit.Size.avatarSm)
            }
        }
    }
}
