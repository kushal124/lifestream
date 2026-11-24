import SwiftUI

public struct MonthMenu: View {
    public struct Month: Hashable, Sendable {
        public let year: Int
        public let month: Int?

        public init(year: Int, month: Int? = nil) {
            self.year = year
            self.month = month
        }

        public var words: String {
            month.map { "\(DateRow.Day.months[$0 - 1]) \(year)" } ?? String(year)
        }

        var name: String { month.map { DateRow.Day.months[$0 - 1] } ?? String(year) }
    }

    let label: String
    @Binding var shown: Month
    let months: [Month]

    public init(_ label: String, shown: Binding<Month>, months: [Month]) {
        self.label = label
        self._shown = shown
        self.months = months
    }

    public var body: some View {
        let years = Set(months.map(\.year)).count > 1 && months.contains { $0.month != nil }
        MenuRow(label, selection: $shown,
                options: months.map { MenuRow.Option($0, years ? $0.name : $0.words, group: years ? String($0.year) : nil) },
                words: shown.words, pill: true)
    }
}
