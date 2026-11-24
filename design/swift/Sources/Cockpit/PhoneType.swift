import SwiftUI

public extension Cockpit.Style {
    static let phoneTime = Cockpit.TextStyle(size: 13, lineHeight: 18, weight: 400, design: .default, textStyle: .footnote,
                                     tracking: 0, italic: false, tabular: true, uppercase: false)
    static let phoneData = Cockpit.TextStyle(size: 13, lineHeight: 18, weight: 400, design: .default, textStyle: .footnote,
                                     tracking: 0, italic: false, tabular: true, uppercase: false)
    static let phoneRowTitle = Cockpit.TextStyle(size: 17, lineHeight: 22, weight: 400, design: .default, textStyle: .body,
                                         tracking: 0, italic: false, tabular: false, uppercase: false)
    static let phoneTitle2 = Cockpit.TextStyle(size: 22, lineHeight: 28, weight: 600, design: .default, textStyle: .title2,
                                       tracking: 0, italic: false, tabular: false, uppercase: false)
    static let phoneFigure = Cockpit.TextStyle(size: 28, lineHeight: 34, weight: 600, design: .default, textStyle: .title,
                                       tracking: 0, italic: false, tabular: true, uppercase: false)
}

public extension Cockpit.Color {
    static let accent = here

    #if os(iOS)
    static let rule = phoneRule
    #else
    static let rule = hairline
    #endif
}

extension Cockpit.ShadowSet {
    static let none = Cockpit.ShadowSet(dark: [], light: [], darkHC: [], lightHC: [])
}
