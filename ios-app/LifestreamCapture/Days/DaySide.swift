import Cockpit
import CoreLocation
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct DaySide: View {
    typealias Place = HomeLink.Pages.SidePlace
    typealias Person = HomeLink.Pages.SidePerson
    typealias Group = HomeLink.Pages.SideGroup

    let side: HomeLink.Pages.DaySide
    let reveal: (_ rows: [String]) -> Void
    let openMoment: (_ row: String) -> Void
    @State private var everyone = false
    @State private var everyGroup = false

    static let most = 14
    static let mostGroups = 5
    static let leastOnMap = 10

    private var places: [Place] { side.places }
    private var people: [Person] { side.people }
    private var groups: [Group] { side.groups }

    static func onMap(_ side: HomeLink.Pages.DaySide) -> [DayMapCard.Stay] {
        side.places.filter { $0.ms / 60_000 >= leastOnMap }.map {
            DayMapCard.Stay(id: $0.key, name: $0.name, point: CLLocationCoordinate2D(latitude: $0.point.latitude, longitude: $0.point.longitude),
                            minutes: $0.ms / 60_000, time: $0.length, reach: $0.radiusM ?? 100)
        }
    }

    static func drawsMap(_ side: HomeLink.Pages.DaySide) -> Bool {
        side.located && !onMap(side).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if Self.drawsMap(side) {
                DayMapCard(stays: Self.onMap(side)) { id in
                    if let place = places.first(where: { $0.key == id }) { press(place) }
                }
                .padding(.top, 24)
                .id("day.map")
                .accessibilityIdentifier("day.map")
            }
            if !places.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    SideLabel("Places", count: places.count)
                    ForEach(places, id: \.key) { place in
                        PlaceUnit(place.name, minutes: place.length, line: place.home ? "your home" : place.line.map(Arriving.words),
                                  quiet: place.quiet) {
                            press(place)
                        }
                        .accessibilityLabel(place.spoken)
                        .footRuled(place.key != places.last?.key, edge: Cockpit.Gap.edge)
                        .accessibilityIdentifier("day.place.\(place.key)")
                    }
                }
                .padding(.top, 24)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("day.places")
            }
            if !people.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    SideLabel("People", count: people.count)
                    let shown = everyone || people.count <= Self.most ? people : Array(people.prefix(Self.most))
                    ForEach(Array(shown.enumerated()), id: \.element.key) { index, person in
                        row(person, ruled: index < shown.count - 1)
                            .accessibilityIdentifier("day.person.\(index)")
                    }
                    if shown.count < people.count {
                        more(people.count - shown.count) { everyone = true }
                            .accessibilityIdentifier("day.people.more")
                    }
                }
                .padding(.top, !places.isEmpty ? 28 : 24)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("day.people")
            }
            if !groups.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    SideLabel("Groups", count: groups.count)
                    let shown = everyGroup || groups.count <= Self.mostGroups ? groups : Array(groups.prefix(Self.mostGroups))
                    ForEach(Array(shown.enumerated()), id: \.element.chat) { index, group in
                        PersonRow(group.title, runs: group.runs.map(Self.run), quiet: group.quiet) {
                            if let row = group.rows.first { openMoment(row) }
                        }
                        .accessibilityLabel(group.spoken)
                            .footRuled(index < shown.count - 1, edge: Cockpit.Gap.edge + Cockpit.listFace + Cockpit.Space.s5)
                            .accessibilityIdentifier("day.group.\(index)")
                    }
                    if shown.count < groups.count {
                        more(groups.count - shown.count) { everyGroup = true }
                            .accessibilityIdentifier("day.groups.more")
                    }
                }
                .padding(.top, !places.isEmpty || !people.isEmpty ? 28 : 24)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("day.groups")
            }
        }
    }

    private func more(_ count: Int, _ all: @escaping () -> Void) -> some View {
        Button {
            withAnimation(.easeOut(duration: Cockpit.Duration.fast)) { all() }
        } label: {
            Text("\(Words.count(count)) more")
                .cockpit(Cockpit.Style.iosSubhead)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .padding(.horizontal, Cockpit.Gap.edge)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func row(_ person: Person, ruled: Bool) -> some View {
        PersonRow(person.name, photo: HomePictures.shared.face(person.photo), runs: person.runs.map(Self.run)) {
            if let id = person.person { AppNavigation.shared.push(.person(id)) } else { reveal(person.rows) }
        }
        .accessibilityLabel(person.spoken)
        .readsFace(person.photo, size: .row)
        .footRuled(ruled, edge: Cockpit.Gap.edge + Cockpit.listFace + Cockpit.Space.s5)
    }

    private func press(_ place: Place) {
        if let slug = place.slug { AppNavigation.shared.push(.place(slug)) } else { reveal(place.rows) }
    }

    static func run(_ run: HomeLink.Pages.ContactRun) -> ContactRun {
        let glyph: Cockpit.Icon = switch run.glyph {
        case .call: .call
        case .callMissed: .callMissed
        case .message, .unknown: .message
        }
        return ContactRun(glyph, run.value, said: run.value)
    }
}

private extension View {
    func footRuled(_ on: Bool, edge: CGFloat) -> some View {
        overlay(alignment: .bottom) {
            if on {
                Rectangle()
                    .fill(Cockpit.Color.rule)
                    .frame(height: Cockpit.pixelRule)
                    .padding(.leading, edge)
                    .padding(.trailing, Cockpit.Gap.edge)
            }
        }
    }
}

private struct SideLabel: View {
    let title: String
    let count: Int

    init(_ title: String, count: Int) {
        self.title = title
        self.count = count
    }

    var body: some View {
        SectionLabel(title, count: count)
            .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
            .padding(.horizontal, Cockpit.Gap.edge)
    }
}
