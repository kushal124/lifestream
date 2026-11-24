import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

@MainActor
enum HitWords {
    static func excerpt(_ line: String?) -> ListRow<EmptyView>.Excerpt {
        ListRow<EmptyView>.Excerpt(SearchWords.snippet(line ?? "").map { ListRow<EmptyView>.Excerpt.Run($0.text, marked: $0.marked) })
    }

    static func when(_ when: HomeLink.Pages.When?, today: String, dated: Bool) -> String? {
        switch when {
        case .at(let ms)?, .clock(let ms)?:
            let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
            let day = HomeClock.current.dayAt(date).day, clock = Words.clock(date)
            return dated ? Words.stampWhen(day, today: today, clock: clock).trimmingCharacters(in: .whitespaces)
                : Words.rowDay(day, today: today, clock: clock)
        case .day(let day)?: return Words.rowDay(day, today: today)
        case .month(let month)?: return Words.month(ofDay: month + "-01", today: today)
        case .unknown?, nil: return nil
        }
    }

    static func clock(_ when: HomeLink.Pages.When?) -> String? {
        switch when {
        case .at(let ms)?, .clock(let ms)?: Words.clock(Date(timeIntervalSince1970: TimeInterval(ms) / 1000))
        case .day?, .month?, .unknown?, nil: nil
        }
    }

    static func icon(_ family: String) -> Cockpit.Icon {
        Cockpit.Icon(rawValue: SearchWords.family(family).icon) ?? .info
    }
}

struct HitRow: View {
    let family: HomeLink.Pages.SearchFamily
    let title: String
    let line: String?
    let when: HomeLink.Pages.When?
    let picture: String?
    let today: String
    var dated = false
    var unopened: String?
    let identifier: String
    let separator: Bool
    let action: () -> Void

    var body: some View {
        let excerpt = HitWords.excerpt(line)
        let stamp = HitWords.when(when, today: today, dated: dated)
        let drawn = HomePictures.shared.face(picture)
        VStack(alignment: .leading, spacing: 0) {
            ListRow(title, excerpt: excerpt, leading: leading(drawn), stamp: stamp, chevron: false, separator: separator && unopened == nil,
                    action: action)
                .readsFace(picture, size: .row)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel([SearchWords.family(family.rawValue).label, title, excerpt.words, stamp ?? ""].filter { !$0.isEmpty }
                    .joined(separator: ", "))
                .accessibilityAddTraits(.isButton)
                .accessibilityIdentifier(identifier)
            if let unopened { Unopened(words: unopened) }
        }
    }

    private func leading(_ picture: Image?) -> ListRow<EmptyView>.Leading {
        switch family {
        case .messages: .monogram(title)
        default: .tile(HitWords.icon(family.rawValue), picture: picture)
        }
    }
}

struct TrackRow: View {
    let title: String
    let line: String
    let separator: Bool
    let action: () -> Void

    var body: some View {
        ListRow(title, excerpt: .init(line), leading: .tile(.listening), chevron: false, separator: separator, action: action)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel([SearchWords.family("listening").label, title, line].joined(separator: ", "))
            .accessibilityAddTraits(.isButton)
    }
}

struct SittingRow: View {
    let title: String
    let line: String?
    let when: HomeLink.Pages.When
    let today: String
    var dated = false
    let separator: Bool
    let action: () -> Void

    var body: some View {
        let excerpt = line.map { HitWords.excerpt($0) }
        let stamp = HitWords.when(when, today: today, dated: dated)
        ListRow(title, excerpt: excerpt, leading: .tile(HitWords.icon("screen")), stamp: stamp, chevron: false, separator: separator,
                action: action)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel([SearchWords.family("screen").label, title, excerpt?.words ?? "", stamp ?? ""].filter { !$0.isEmpty }
                .joined(separator: ", "))
            .accessibilityAddTraits(.isButton)
    }
}

struct PersonHitRow: View {
    let name: String
    let id: String?
    let face: String?
    let line: String?
    let separator: Bool
    let action: () -> Void

    var body: some View {
        let drawn = HomePictures.shared.face(face)
        ListRow(name, excerpt: line.map { .init($0) }, leading: .monogram(name, photo: drawn), chevron: false, separator: separator,
                action: action)
            .readsFace(face, size: .row)
            .facesValue(face, drawn: drawn)
            .accessibilityIdentifier("search.goto.person.\(id ?? name)")
    }
}

struct PlaceHitRow: View {
    let name: String
    let slug: String
    let line: String?
    let separator: Bool
    let action: () -> Void

    var body: some View {
        ListRow(name, excerpt: line.map { .init($0) }, leading: .tile(.place), chevron: false, separator: separator, action: action)
            .accessibilityIdentifier("search.goto.place.\(slug)")
    }
}

struct Unopened: View {
    let words: String

    var body: some View {
        Text(words)
            .cockpit(.footnote)
            .foregroundStyle(Cockpit.Color.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, Cockpit.Space.s4 + Cockpit.Size.lead + Cockpit.Space.s4)
            .padding(.bottom, Cockpit.Space.s2)
            .accessibilityIdentifier("search.unopened")
    }
}

extension HitRow {
    @ViewBuilder static func reading(_ count: Int, from start: Int = 0) -> some View {
        let titles = ["Person A", "The synthetic invoice", "Group Alpha", "Notes from the week", "Synthetic Gym", "Person B"]
        let words = ["See you at «synthetic» lunch tomorrow", "Your «synthetic» invoice for October", "Who is bringing the «synthetic» cake?",
                     "A «synthetic» plan for the month", "Forty-two minutes near «synthetic» weights", "Sent the «synthetic» photos"]
        ForEach(0..<count, id: \.self) { offset in
            let index = (start + offset) % titles.count
            ListRow(titles[index], excerpt: HitWords.excerpt(words[index]), leading: index % 2 == 0 ? .monogram(titles[index]) : .tile(.mail),
                    stamp: "16:42", chevron: false, separator: offset < count - 1)
        }
    }
}
