import Cockpit
import SwiftUI
import UIKit

extension Image {
    @MainActor
    init(icon meaning: Cockpit.Icon, size: Cockpit.IconSize = .lg) {
        self.init(uiImage: UIImage.icon(meaning, size: size))
    }
}

extension UIImage {
    @MainActor
    static func icon(_ meaning: Cockpit.Icon, size: Cockpit.IconSize = .lg) -> UIImage {
        let key = "\(meaning.rawValue) \(size.points)"
        if let drawn = drawings[key] { return drawn }
        let rect = CGRect(x: 0, y: 0, width: size.points, height: size.points)
        let drawing = UIGraphicsImageRenderer(size: rect.size).image { context in
            context.cgContext.addPath(IconShape(meaning: meaning).path(in: rect).cgPath)
            context.cgContext.fillPath()
        }.withRenderingMode(.alwaysTemplate)
        drawings[key] = drawing
        return drawing
    }

    @MainActor private static var drawings: [String: UIImage] = [:]
}
