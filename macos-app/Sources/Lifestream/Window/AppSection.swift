enum AppSection: String, CaseIterable {
    case ask, days, people, places, connectors

    var title: String {
        switch self {
        case .ask: return "Chat"
        case .days: return "Timeline"
        case .people: return "People"
        case .places: return "Places"
        case .connectors: return "Connectors"
        }
    }

    static let thisMac = "settings/mac"

    static let privacy = "settings/privacy"

    static let settings = "settings"

    static let feedback = "feedback"

    static let onboardingView = "onboarding"
}
