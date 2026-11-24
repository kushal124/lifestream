import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct DaysList: View {
    let month: String?
    let shown: String
    let open: (String) -> Void
    @ObservedObject private var days = DaysModel.shared

    var body: some View {
        let months = months
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(months, id: \.self) { month in
                            VStack(alignment: .leading, spacing: 0) {
                                MonthHead(month: month, months: months) { chosen in
                                    withAnimation(Cockpit.Ease.out(Cockpit.Duration.base)) { proxy.scrollTo(chosen, anchor: .top) }
                                }
                                MonthGrid(month: month, written: days.written, totals: days.totals, today: days.today,
                                          shown: shown, open: open)
                            }
                            .id(month)
                        }
                    }
                    .padding(.top, Cockpit.Space.s3)
                }
                .padding(.bottom, Cockpit.Space.s4)
            }
            .barTitleScroll(current: true)
            .accessibilityIdentifier("days.list")
            .groundColor(Cockpit.Color.canvas)
            .onAppear {
                let at = month ?? Self.month(of: shown)
                if at != months.first, months.contains(at) {
                    proxy.scrollTo(at, anchor: .top)
                }
            }
        }
    }

    private var months: [String] {
        let newest = Self.month(of: days.today)
        let oldest = days.written.min().map(Self.month(of:)) ?? newest
        var months: [String] = []
        var at = newest
        while at >= oldest {
            months.append(at)
            at = Self.month(of: Words.shiftDay(at + "-01", -1))
        }
        return months
    }

    static func month(of day: String) -> String {
        String(day.prefix(7))
    }
}

private struct MonthHead: View {
    let month: String
    let months: [String]
    let choose: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MonthMenu("Month", shown: Binding(get: { Self.menu(month) }, set: { chosen in
                choose(String(format: "%04d-%02d", chosen.year, chosen.month ?? 1))
            }), months: months.map(Self.menu))
            .padding(.horizontal, Cockpit.Gap.edge - Cockpit.Space.s1)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("days.month.\(month)")
            HStack(spacing: 0) {
                ForEach(Array(MonthGrid.week.enumerated()), id: \.offset) { _, letter in
                    Text(letter)
                        .cockpit(Cockpit.Style.iosSubhead)
                        .foregroundStyle(Cockpit.Color.textTertiary)
                        .frame(maxWidth: .infinity)
                }
            }
            .frame(height: 20)
            .padding(.horizontal, Cockpit.Gap.edge)
            .accessibilityHidden(true)
        }
        .padding(.bottom, Cockpit.Space.s1)
    }

    static func menu(_ month: String) -> MonthMenu.Month {
        MonthMenu.Month(year: Int(month.prefix(4)) ?? 1970, month: Int(month.dropFirst(5).prefix(2)) ?? 1)
    }
}

private struct MonthGrid: View {
    let month: String
    let written: Set<String>
    let totals: [String: Int]
    let today: String?
    let shown: String?
    let open: (String) -> Void

    static let week = ["M", "T", "W", "T", "F", "S", "S"]
    static let height: CGFloat = 48

    var body: some View {
        let cells = cells
        let most = cells.compactMap { $0.flatMap { totals[$0] } }.max() ?? 0
        VStack(spacing: 0) {
            ForEach(0..<(cells.count / 7), id: \.self) { row in
                HStack(spacing: 0) {
                    ForEach(0..<7, id: \.self) { column in
                        if let day = cells[row * 7 + column] {
                            DayCell(day: day, live: written.contains(day), mark: Self.mark(totals[day], most: most),
                                    today: day == today, selected: day == shown) { open(day) }
                        } else {
                            Color.clear.frame(maxWidth: .infinity, minHeight: Self.height)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, Cockpit.Gap.edge)
        .padding(.bottom, Cockpit.Space.s4)
    }

    private var cells: [String?] {
        let first = month + "-01"
        let offset = (Words.weekday(ofDay: first) + 5) % 7
        var days: [String?] = Array(repeating: nil, count: offset)
        var day = first
        while day.hasPrefix(month) {
            days.append(day)
            day = Words.shiftDay(day, 1)
        }
        days += Array(repeating: nil, count: (7 - days.count % 7) % 7)
        return days
    }

    static func mark(_ total: Int?, most: Int) -> CGFloat? {
        guard let total else { return nil }
        guard total > 0, most > 0 else { return 6 }
        let share = Double(total) / Double(most)
        return share > 0.75 ? 24 : share > 0.5 ? 18 : share > 0.25 ? 12 : 6
    }
}

private struct DayCell: View {
    let day: String
    let live: Bool
    let mark: CGFloat?
    let today: Bool
    let selected: Bool
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            ZStack {
                Text(String(Int(day.suffix(2)) ?? 0))
                    .cockpit(Cockpit.Style.iosBody)
                    .fontWeight(today ? .semibold : nil)
                    .monospacedDigit()
                    .foregroundStyle(today ? Cockpit.Color.here : live ? Cockpit.Color.text : Cockpit.Color.textDisabled)
                    .offset(y: -3)
                if live, mark != nil {
                    Circle()
                        .fill(Cockpit.Color.textTertiary)
                        .frame(width: 4, height: 4)
                        .offset(y: 12)
                }
            }
            .frame(maxWidth: .infinity, minHeight: MonthGrid.height)
            .contentShape(Rectangle())
        }
        .buttonStyle(DayPress(selected: selected, today: today))
        .disabled(!live)
        .accessibilityLabel(Words.longDay(day, today: HomeClock.current.today()))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("days.day.\(day)")
    }
}

private struct DayPress: ButtonStyle {
    let selected: Bool
    let today: Bool

    func makeBody(configuration: Configuration) -> some View {
        ZStack {
            Circle()
                .fill(configuration.isPressed ? Cockpit.Color.pressed
                      : selected ? (today ? Cockpit.Color.here.opacity(0.2) : Cockpit.Color.selection) : .clear)
                .frame(width: Cockpit.Size.target, height: Cockpit.Size.target)
            configuration.label
        }
        .animation(.easeOut(duration: Cockpit.Duration.instant), value: configuration.isPressed)
    }
}
