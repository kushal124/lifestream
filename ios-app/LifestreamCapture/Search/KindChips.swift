import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct KindChips: View {
    @ObservedObject var model: SearchModel
    let found: SearchModel.Search?

    var body: some View {
        HStack(spacing: Cockpit.Space.s2) {
            HStack(spacing: 0) {
                if let found {
                    ChipRow(Self.chips(found), selection: chosen, allCount: found.total.n, allAtLeast: found.total.partial, multiple: false)
                } else {
                    ChipRow([Chip("Messages", count: 128), Chip("Mail", count: 42), Chip("Listening", count: 7)], selection: .constant([]))
                }
            }
            .reading(found == nil)
            .contentMargins(.trailing, Cockpit.Space.s12, for: .scrollContent)
            .mask {
                HStack(spacing: 0) {
                    Rectangle()
                    LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black.opacity(0.6), location: 0.35),
                                           .init(color: .black.opacity(0.2), location: 0.7), .init(color: .clear, location: 1)],
                                   startPoint: .leading, endPoint: .trailing)
                        .frame(width: Cockpit.Space.s12)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            MenuRow("When", selection: $model.span, options: spans, default: .some(nil), pill: true)
                .fixedSize()
                .accessibilityIdentifier("search.when")
        }
        .frame(minHeight: Cockpit.Size.target)
    }

    private var spans: [MenuRow<SearchWords.Span?>.Option] {
        [MenuRow<SearchWords.Span?>.Option(nil, "Any time")] + model.spans.map { MenuRow<SearchWords.Span?>.Option($0, $0.label) }
    }

    private var chosen: Binding<Set<String>> {
        Binding(get: { Set([model.kind].compactMap { $0 }) }, set: { picked in
            model.upcoming = false
            model.kind = picked.first
        })
    }

    static func chips(_ found: SearchModel.Search) -> [Chip<String>] {
        found.kinds.map { kind in
            Chip(kind.title, id: kind.family.rawValue, count: kind.count?.n, atLeast: kind.count?.partial ?? false)
        }
    }
}
