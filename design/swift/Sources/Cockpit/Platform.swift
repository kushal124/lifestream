import SwiftUI

public extension Cockpit {
    enum Platform: String, CaseIterable, Sendable {
        case ios, mac

        public static var current: Platform {
            #if os(macOS)
            return .mac
            #else
            return .ios
            #endif
        }

        public func style(_ role: Role) -> TextStyle {
            typealias S = Cockpit.Style
            switch (self, role) {
            case (.ios, .display): return S.iosDisplay
            case (.ios, .title1): return S.iosTitle1
            case (.ios, .title2), (.ios, .title3): return S.phoneTitle2
            case (.ios, .headline): return S.iosHeadline
            case (.ios, .body): return S.iosBody
            case (.ios, .reading): return S.iosReading
            case (.ios, .rowTitle): return S.phoneRowTitle
            case (.ios, .subhead): return S.iosSubhead
            case (.ios, .footnote): return S.iosFootnote
            case (.ios, .caption), (.ios, .caption2): return S.iosCaption
            case (.ios, .label): return S.iosLabel
            case (.ios, .figureXL): return S.phoneFigure
            case (.ios, .figureL): return S.iosFigureL
            case (.ios, .figureM): return S.iosFigureM
            case (.ios, .monoTime): return S.phoneTime
            case (.ios, .monoLabel): return S.iosSubhead
            case (.ios, .monoData): return S.phoneData
            case (.ios, .voice): return S.iosVoice
            case (.ios, .voiceL): return S.iosVoiceL
            case (.mac, .display): return S.macDisplay
            case (.mac, .title1): return S.macTitle1
            case (.mac, .title2), (.mac, .title3): return S.macTitle2
            case (.mac, .headline), (.mac, .rowTitle): return S.macHeadline
            case (.mac, .body): return S.macBody
            case (.mac, .reading): return S.macReading
            case (.mac, .subhead): return S.macSubhead
            case (.mac, .footnote), (.mac, .caption), (.mac, .caption2): return S.macFootnote
            case (.mac, .label): return S.macLabel
            case (.mac, .figureXL), (.mac, .figureL): return S.macFigureL
            case (.mac, .figureM): return S.macFigureM
            case (.mac, .monoTime): return S.macMonoTime
            case (.mac, .monoLabel): return S.macMonoLabel
            case (.mac, .monoData): return S.macMonoData
            case (.mac, .voice): return S.macVoice
            case (.mac, .voiceL): return S.macVoiceL
            }
        }

        public var cardRadius: CGFloat { self == .ios ? Space.s4 : Radius.lg }
        public var cardPadding: CGFloat { self == .ios ? Space.s4 : Space.s5 }
        public var margin: CGFloat { self == .ios ? Space.s5 : Space.s6 }
        public var rowHeight: CGFloat { self == .ios ? 52 : Size.rowMac }
        public var hitSize: CGFloat { self == .ios ? Size.target : Size.controlMac }
        public var controlHeight: CGFloat { self == .ios ? Size.controlMd : Size.controlMac }
        public var iconSize: CGFloat { self == .ios ? Size.iconMd : Size.iconSm }
        public var iconColumn: CGFloat { self == .ios ? Space.s6 : 24 }
        public var tileRadius: CGFloat { Radius.xs }
    }

    enum Role: Sendable {
        case display, title1, title2, title3, headline, body, reading, rowTitle, subhead, footnote, caption, caption2, label
        case figureXL, figureL, figureM
        case monoTime, monoLabel, monoData
        case voice, voiceL
    }
}

private struct PlatformKey: EnvironmentKey {
    static let defaultValue = Cockpit.Platform.current
}

public extension EnvironmentValues {
    var cockpitPlatform: Cockpit.Platform {
        get { self[PlatformKey.self] }
        set { self[PlatformKey.self] = newValue }
    }
}

public extension View {
    func cockpitPlatform(_ platform: Cockpit.Platform) -> some View {
        environment(\.cockpitPlatform, platform)
    }

    func cockpit(_ role: Cockpit.Role) -> some View {
        modifier(CockpitRoleText(role: role))
    }
}

private struct CockpitRoleText: ViewModifier {
    let role: Cockpit.Role
    @Environment(\.cockpitPlatform) private var platform
    func body(content: Content) -> some View {
        content.cockpit(platform.style(role))
    }
}
