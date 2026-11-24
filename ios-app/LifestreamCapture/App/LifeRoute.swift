import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

enum LifeRoute: Hashable {
    case day(String, focus: String? = nil)
    case person(String)
    case personPhotos(String)
    case group(String)
    case place(String)
    case placeVisits(String)
    case placePhotos(String)
    case hiddenSpots
    case placesOnce(String)
    case month(String)
    case trip(String)
    case chat(String)
    case moment(day: String, focus: String)
    case track(String, artist: String?)
    case sitting(SearchModel.Sitting)
}

extension LifeRoute {
    static func opening(_ opens: HomeLink.Opens, family: String? = nil) -> LifeRoute? {
        switch opens {
        case .days(let day, let focus): days(day, focus: focus, family: family)
        case .people(let id, let person, let group): people(id, person: person, group: group)
        case .places(let slug): .place(slug)
        case .read: nil
        }
    }

    static func opening(_ opens: HomeLink.Pages.Opens, family: String?) -> LifeRoute? {
        switch opens {
        case .days(let day, let focus): days(day, focus: focus, family: family)
        case .month(let month, _): .month(month)
        case .people(let id, let person, let group): people(id, person: person, group: group)
        case .places(let slug): .place(slug)
        case .read, .unknown: nil
        }
    }

    private static func days(_ day: String, focus: String?, family: String?) -> LifeRoute {
        guard let focus else { return .day(day) }
        if let family, opensItsThing(family) { return .moment(day: day, focus: focus) }
        return .day(day, focus: focus)
    }

    private static func people(_ id: String, person: String?, group: String?) -> LifeRoute {
        if let person { return .person(person) }
        if let group { return .group(group) }
        return .person(id)
    }

    private static func opensItsThing(_ family: String) -> Bool {
        ["messages", "ai", "mail"].contains(family)
    }
}

extension View {
    func lifeDestinations() -> some View {
        navigationDestination(for: LifeRoute.self) { LifeScreen(route: $0) }
    }
}

private struct LifeScreen: View {
    let route: LifeRoute

    var body: some View {
        switch route {
        case .day, .month, .chat: screen.environment(\.rootBarFoot, AnyView(HomeStrip()))
        default: screen.safeAreaBar(edge: .top, spacing: 0) { HomeStrip() }
        }
    }

    @ViewBuilder private var screen: some View {
        switch route {
        case .day(let day, let focus): DayScreen(day: day, focus: focus)
        case .person(let id): PersonScreen(id: id)
        case .personPhotos(let id): PersonPhotosScreen(id: id)
        case .group(let key): GroupScreen(key: key)
        case .place(let slug): PlaceScreen(slug: slug)
        case .placeVisits(let slug): PlaceVisitsScreen(slug: slug)
        case .placePhotos(let slug): PlacePhotosScreen(slug: slug)
        case .hiddenSpots: HiddenSpotsScreen()
        case .placesOnce(let city): PlacesOnceScreen(city: city)
        case .month(let month): DayScreen(month: month)
        case .trip(let first): TripScreen(first: first)
        case .chat(let key): AskThread(conversation: AskBook.shared.conversation(key)).id(key)
        case .moment(let day, let focus): MomentPage(day: day, focus: focus)
        case .track(let track, let artist): TrackPage(track: track, artist: artist)
        case .sitting(let sitting): SittingPage(sitting: sitting)
        }
    }
}
