import Cockpit
import HomeLink
import SwiftUI

enum CitedOpening: Equatable {
    case moment(day: String, focus: String)
    case day(String)
    case route(LifeRoute)
    case row(ref: String, asked: String)
    case nothing

    static func of(_ citation: HomeLink.Citation) -> CitedOpening {
        switch citation.opens {
        case nil: return .nothing
        case .read: return citation.kind == .row ? .row(ref: citation.ref, asked: citation.asked ?? "") : .nothing
        case .days(let day, let focus):
            guard let focus else { return .day(day) }
            return .moment(day: day, focus: focus)
        case let opens?: return LifeRoute.opening(opens).map(CitedOpening.route) ?? .nothing
        }
    }

    static func unopened(_ citation: HomeLink.Citation) -> String {
        citation.kind == .gone ? citation.why ?? "This is no longer in your record." : "Can't open this on iPhone yet."
    }

}

struct AskStatsSheet: View {
    let ref: String
    let asked: String
    let again: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var read: Read = .reading
    @State private var later: [[HomeLink.JSON]] = []
    @State private var next: String?
    @State private var more: More = .idle

    enum More: Equatable {
        case idle
        case reading
        case failed(String)
    }

    enum Read {
        case reading
        case read(LifeReader.RowOpened)
        case failed(LifeReader.Failure)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Cockpit.Space.s4) {
                    Text(asked).cockpit(.rowTitle).foregroundStyle(Cockpit.Color.text)
                        .fixedSize(horizontal: false, vertical: true)
                    switch read {
                    case .reading: WaitLine()
                    case .read(.facts(let facts)): table(facts)
                    case .read(.gone):
                        Text("This count can’t be opened any more.")
                            .cockpit(.body).foregroundStyle(Cockpit.Color.textSecondary)
                        Button("Ask again") {
                            again(asked)
                            dismiss()
                        }
                        .buttonStyle(.cockpit(.secondary))
                    case .failed(let failure):
                        InPlaceLine(PeopleWords.failure(failure) ?? "Couldn't read this number.") { Task { await load() } }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Cockpit.Gap.edge)
            }
            .navigationTitle("Behind the number")
            .navigationBarTitleDisplayMode(.inline)
        }
        .accessibilityIdentifier("ask.stats")
        .task(id: ref) { await load() }
    }

    private func load() async {
        read = .reading
        later = []
        next = nil
        more = .idle
        do {
            let opened = try await AppRuntime.shared.life.rowFacts(ref)
            if case .facts(let facts) = opened { next = facts.next }
            read = .read(opened)
        } catch let failure as LifeReader.Failure {
            read = .failed(failure)
        } catch {
            read = .failed(.refused(String(describing: error)))
        }
    }

    private func readMore() async {
        guard let cursor = next, more != .reading else { return }
        more = .reading
        do {
            guard case .facts(let page) = try await AppRuntime.shared.life.rowFacts(ref, cursor: cursor) else {
                more = .failed("This count can’t be opened any more.")
                return
            }
            later += page.rows
            next = page.next
            more = .idle
        } catch let failure as LifeReader.Failure {
            more = .failed(PeopleWords.failure(failure) ?? "Couldn't read more of this number.")
        } catch {
            more = .failed("Couldn't read more of this number.")
        }
    }

    private func table(_ facts: HomeLink.Read.Row) -> some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
            if let now = facts.now, now != facts.n {
                Text(Self.moved(facts.n, now: now)).cockpit(.body).foregroundStyle(Cockpit.Color.textSecondary)
            }
            let rows = facts.rows + later
            ForEach(rows.indices, id: \.self) { index in
                Text(Self.fact(rows[index], columns: facts.columns))
                    .cockpit(.body).foregroundStyle(Cockpit.Color.text)
            }
            if case .failed(let words) = more {
                InPlaceLine(words) { Task { await readMore() } }
            } else if next != nil {
                Button("More") { Task { await readMore() } }
                    .buttonStyle(.cockpit(.plain, size: .small))
                    .disabled(more == .reading)
                    .accessibilityIdentifier("ask.stats.more")
            }
        }
    }

    nonisolated static func fact(_ cells: [HomeLink.JSON], columns: [String]) -> String {
        zip(columns, cells.dropLast()).compactMap { column, cell in
            let words = Self.words(cell)
            return words.isEmpty ? nil : "\(column): \(words)"
        }.joined(separator: " · ")
    }

    nonisolated static func moved(_ n: Int, now: Int) -> String {
        "The answer counted \(n.formatted()); there are \(now.formatted()) now."
    }

    nonisolated static func words(_ cell: HomeLink.JSON) -> String {
        switch cell {
        case .null: ""
        case .bool(let value): value ? "yes" : "no"
        case .number(let value): value.rounded() == value ? String(Int(value)) : String(value)
        case .string(let value): value
        case .array(let values): values.map(words).joined(separator: ", ")
        case .object: ""
        }
    }
}
