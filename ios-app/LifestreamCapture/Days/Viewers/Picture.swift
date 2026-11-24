import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI
import UIKit

extension Inspector {
    struct Picture: View {
        let hash: String
        var width: CGFloat?
        let height: CGFloat
        var fill = true
        var corner: CGFloat = Cockpit.Radius.sm
        @Environment(\.displayScale) private var scale

        var body: some View {
            Inspector.Reading(missing: "This picture is not in Lifestream.", {
                let want = HomePictures.want(CGSize(width: width ?? HomePictures.screen.width, height: height), scale: scale, fill: fill)
                return try await HomePictures.shared.read(hash, want.size, side: want.side)
            }, skeleton: {
                MapBox(height: height, corner: corner)
            }) { image in
                if let image, fill {
                    Color.clear
                        .frame(maxWidth: .infinity)
                        .frame(height: height)
                        .overlay { Image(uiImage: image).resizable().scaledToFill() }
                        .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
                        .contentShape(Rectangle())
                        .accessibilityValue(AppRuntime.isUITesting ? "drawn" : "")
                } else if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
                        .frame(maxWidth: .infinity, maxHeight: height)
                        .accessibilityValue(AppRuntime.isUITesting ? "drawn" : "")
                } else {
                    Inspector.Line(text: "This file is not a picture.")
                }
            }
        }
    }
}
