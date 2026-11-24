import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct HiddenSpotsScreen: View {
    @EnvironmentObject private var model: PlacesModel
    @State private var all = false
    @State private var attempt = PlaceAttempt()

    static let first = 20

    var body: some View {
        let hidden = model.hidden
        let shown = all ? hidden : Array(hidden.prefix(Self.first))
        OnePage("Hidden spots", inBar: true) {
            if hidden.isEmpty {
                EmptyState(.hidden, "No hidden spots.")
            }
            VStack(spacing: Cockpit.Space.s3) {
                ForEach(shown, id: \.key) { spot in
                    HiddenSpotRow(spot: spot) { Task { await model.unhide(key: spot.key, in: attempt) } }
                        .accessibilityIdentifier("hidden.spot.\(spot.key)")
                        .transition(.opacity)
                }
                if !all, hidden.count > shown.count {
                    Button("Show all \(Words.count(hidden.count))") { all = true }
                        .buttonStyle(.cockpit(.secondary, size: .small))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("hidden.all")
                }
            }
            .animation(.easeOut(duration: Cockpit.Duration.fast), value: hidden.map(\.key))
        }
    }
}

private struct HiddenSpotRow: View {
    @EnvironmentObject private var model: PlacesModel
    let spot: HomeLink.Pages.HiddenRow
    let unhide: () -> Void

    static let span: Double = 260

    var body: some View {
        HiddenSpotCard(id: spot.key, known: spot.line ?? "", hidden: hidden, unhide: unhide) {
            PlacesMap(marks: marks, focus: PlacesMap.Focus(id: spot.key, points: [spot.centre], span: Self.span), moves: false)
                .accessibilityHidden(true)
        }
    }

    private var hidden: String {
        guard case .at(let ms) = spot.hidden else { return "Hidden" }
        return "Hidden " + Words.shortDate(Words.date(ms: Int64(ms)), weekday: false)
    }

    private var marks: [PlacesMap.Mark] {
        model.rows.filter { $0.distance(to: spot.centre) < 600 }.flatMap { PlacesMap.Mark.places($0, back: true) }
            + [PlacesMap.Mark.hidden(spot)]
    }
}
