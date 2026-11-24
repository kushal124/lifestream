import Cockpit
import Foundation

enum MainWindowSize {
    static let onboarding = CGSize(width: Cockpit.Size.onboardingWidth, height: Cockpit.Size.onboardingHeight)

    static let preferred = CGSize(width: 1440, height: 900)
    static let minimum = CGSize(width: 900, height: 600)
    static let margin: CGFloat = 24

    static func initial(screen: CGSize) -> CGSize {
        CGSize(width: max(minimum.width, min(preferred.width, screen.width - 2 * margin)),
               height: max(minimum.height, min(preferred.height, screen.height - 2 * margin)))
    }

    static func grown(from frame: CGRect, screen visible: CGRect) -> CGRect {
        let size = initial(screen: visible.size)
        var grown = CGRect(x: (frame.midX - size.width / 2).rounded(), y: (frame.midY - size.height / 2).rounded(),
                           width: size.width, height: size.height)
        grown.origin.x = min(max(grown.minX, visible.minX), max(visible.minX, visible.maxX - size.width))
        grown.origin.y = min(max(grown.minY, visible.minY), max(visible.minY, visible.maxY - size.height))
        return grown
    }
}
