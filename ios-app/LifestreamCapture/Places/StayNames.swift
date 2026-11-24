import Cockpit
import CoreLocation
import HomeLink
import LifestreamCaptureCore
import MapKit
import SwiftUI

@MainActor
final class StayNames: ObservableObject {
    enum Asked: Equatable {
        case spot(key: String, centre: PlaceCoordinate)

        var centre: PlaceCoordinate {
            switch self {
            case .spot(_, let centre): centre
            }
        }
    }

    @Published private(set) var names: [HomeLink.Suggestion]?
    @Published private(set) var typed = false
    @Published private(set) var need: HomeLink.Suggestions.Provider.Need?
    var moved: (() -> Void)?

    private var asked: Asked?
    private var untyped: [HomeLink.Suggestion]?
    private var homeless = false
    private var words = ""
    private var waiting: Task<Void, Never>?
    private var flying = false
    private var owed = false

    static let pause: Duration = .milliseconds(250)
    static let fewest = 2

    func read(_ asked: Asked) async {
        guard self.asked != asked else { return }
        self.asked = asked
        names = nil
        untyped = nil
        homeless = false
        typed = false
        need = nil
        do {
            let found = try await answer(asked, q: "")
            guard self.asked == asked else { return }
            untyped = found.suggestions
            need = found.provider?.need
        } catch is CancellationError {
            if self.asked == asked { self.asked = nil }
            return
        } catch LifeReader.Failure.missing {
            guard self.asked == asked else { return }
            untyped = []
            names = []
            moved?()
            return
        } catch {
            let apple = await Self.apple(near: asked.centre)
            guard self.asked == asked else { return }
            untyped = apple
            homeless = true
        }
        if words.count < Self.fewest {
            names = untyped
        } else if homeless {
            drawApple()
        }
    }

    private func drawApple() {
        names = (untyped ?? []).filter { Self.holds($0.name, words) }
        typed = true
    }

    func type(_ text: String) {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard words != self.words else { return }
        self.words = words
        waiting?.cancel()
        guard words.count >= Self.fewest else {
            typed = false
            if let untyped { names = untyped }
            return
        }
        waiting = Task { [weak self] in
            try? await Task.sleep(for: Self.pause)
            guard !Task.isCancelled else { return }
            await self?.ask()
        }
    }

    private func ask() async {
        guard !flying else {
            owed = true
            return
        }
        guard let asked else { return }
        flying = true
        defer { flying = false }
        repeat {
            owed = false
            let words = self.words
            guard words.count >= Self.fewest else { return }
            do {
                let found = try await answer(asked, q: words)
                guard self.asked == asked, words == self.words else { continue }
                names = found.suggestions
                typed = true
                need = found.provider?.need
            } catch LifeReader.Failure.missing {
                moved?()
            } catch {
                guard self.asked == asked, words == self.words, homeless else { continue }
                drawApple()
            }
        } while owed
    }

    private func answer(_ asked: Asked, q: String?) async throws -> HomeLink.Suggestions {
        let life = AppRuntime.shared.life
        guard AppRuntime.shared.reach.snapshot.reach != .unpaired else { throw LifeReader.Failure.unpaired }
        switch asked {
        case let .spot(key, _): return try await life.suggest(spot: key, q: q)
        }
    }

    static func apple(near centre: PlaceCoordinate) async -> [HomeLink.Suggestion] {
        if AppRuntime.isUITesting {
            return [.init(name: "Corner Cafe", distanceM: 30), .init(name: "Park Club", distanceM: 60)]
        }
        let location = CLLocationCoordinate2D(latitude: centre.latitude, longitude: centre.longitude)
        let request = MKLocalPointsOfInterestRequest(center: location, radius: 120)
        request.pointOfInterestFilter = MKPointOfInterestFilter(excluding: [.atm, .evCharger, .parking, .publicTransport])
        guard let response = try? await MKLocalSearch(request: request).start() else { return [] }
        var found: [(name: String, metres: Double)] = []
        for item in response.mapItems {
            guard let name = item.name?.trimmingCharacters(in: .whitespaces), !name.isEmpty,
                  !found.contains(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) else { continue }
            let point = item.location.coordinate
            found.append((name, PlaceCoordinate(latitude: point.latitude, longitude: point.longitude).distance(to: centre)))
        }
        return found.sorted { $0.metres < $1.metres }.map { HomeLink.Suggestion(name: $0.name, distanceM: $0.metres) }
    }

    static func glyph(_ suggestion: HomeLink.Suggestion) -> Cockpit.Icon {
        guard suggestion.slug == nil else { return .place }
        return suggestion.why?.family.flatMap { leads[$0] } ?? .place
    }

    private static let leads: [String: Cockpit.Icon] = [
        "calendar": .calendarEvent, "messages": .message, "mail": .mail, "notes": .note, "money": .money,
    ]

    static func holds(_ name: String, _ typed: String) -> Bool {
        let own = words(name)
        return words(typed).allSatisfy { word in own.contains { $0.hasPrefix(word) } }
    }

    private static func words(_ text: String) -> [String] {
        text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil).lowercased()
            .split { !$0.isLetter && !$0.isNumber }.map(String.init)
    }

    static func typed(_ words: String, among names: [HomeLink.Suggestion]?) -> HomeLink.Suggestion {
        let typed = folded(words)
        return names?.first { folded($0.name) == typed }
            ?? HomeLink.Suggestion(name: words.trimmingCharacters(in: .whitespacesAndNewlines), distanceM: nil)
    }

    private static func folded(_ words: String) -> String {
        words.split(whereSeparator: \.isWhitespace).joined(separator: " ").lowercased()
    }

    static func ids(_ suggestion: HomeLink.Suggestion) -> [String] {
        suggestion.id.map { [$0] } ?? []
    }
}

struct StayNameRows: View {
    let names: [HomeLink.Suggestion]?
    let typed: Bool
    let stay: Date
    let pick: (HomeLink.Suggestion) -> Void
    let identifier: String
    @Environment(\.cockpitInSheet) private var inSheet

    var body: some View {
        if let names {
            let shown = typed ? names : Array(names.prefix(3))
            VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                if shown.isEmpty, !typed {
                    Text("Type its name")
                        .cockpit(.subhead)
                        .foregroundStyle(Cockpit.Color.textTertiary)
                        .accessibilityIdentifier("\(identifier).none")
                }
                if !shown.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(Array(shown.enumerated()), id: \.offset) { index, name in
                            if index > 0 {
                                Rectangle().fill(Cockpit.Color.rule).frame(height: Cockpit.pixelRule)
                                    .padding(.leading, NameRow.textEdge)
                                    .padding(.trailing, Cockpit.Space.s4)
                            }
                            NameRow(name.name, source: PlacesWords.source(name, stay: stay), icon: StayNames.glyph(name)) { pick(name) }
                                .accessibilityIdentifier("\(identifier).\(index)")
                                .transition(.opacity)
                        }
                    }
                    .environment(\.cockpitRowInCard, true)
                    .background(inSheet ? Cockpit.Color.raised : Cockpit.Color.surface)
                    .clipShape(RoundedRectangle(cornerRadius: Cockpit.Radius.md, style: .continuous))
                }
            }
            .animation(.easeOut(duration: Cockpit.Duration.fast), value: shown.map(\.name))
        } else {
            VStack(spacing: NameRow.gap) {
                ForEach(0..<3, id: \.self) { _ in
                    NameRow("Lantern Noodle Bar", source: "Calendar · 12:30", icon: .place) {}
                }
            }
            .reading(true)
        }
    }
}
