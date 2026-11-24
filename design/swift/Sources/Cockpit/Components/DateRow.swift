import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

public struct DateRow: View {
    public struct Said {
        let waiting: String?
        let only: String?
        let problem: String?
        let line: String?

        public init(waiting: String? = nil, only: String? = nil, problem: String? = nil, line: String? = nil) {
            self.waiting = waiting
            self.only = only
            self.problem = problem
            self.line = line
        }
    }

    public struct Day: Hashable, Sendable {
        public var month: Int
        public var day: Int
        public var year: Int?

        public init(month: Int, day: Int, year: Int? = nil) {
            self.month = month
            self.day = day
            self.year = year
        }

        public var words: String {
            let date = "\(day) \(Self.months[month - 1])"
            return year.map { "\(date) \($0)" } ?? date
        }

        static let months = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
                             "October", "November", "December"]

        static func days(in month: Int, year: Int?) -> Int {
            switch month {
            case 2:
                guard let year else { return 29 }
                return year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) ? 29 : 28
            case 4, 6, 9, 11: return 30
            default: return 31
            }
        }

        var held: Day {
            Day(month: month, day: min(day, Self.days(in: month, year: year)), year: year)
        }

        static var today: Day {
            let parts = Calendar(identifier: .gregorian).dateComponents([.month, .day], from: Date())
            return Day(month: parts.month ?? 1, day: parts.day ?? 1)
        }
    }

    let label: String
    @Binding var day: Day?
    let empty: String
    @Binding var open: Bool
    let start: Day?
    let years: ClosedRange<Int>
    let clear: String?
    let yearAlways: Bool
    let separator: Bool
    let said: Said
    let held: AnyView?
    var forced: RowHighlight?
    @State private var lastYear: Int?
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.inSettingSection) private var inSection

    public init(_ label: String, day: Binding<Day?>, empty: String, open: Binding<Bool>, start: Day? = nil,
                years: ClosedRange<Int>? = nil, clear: String? = "Clear", yearAlways: Bool = false, separator: Bool = true,
                said: Said = Said(), held: AnyView? = nil) {
        self.label = label
        self._day = day
        self.empty = empty
        self._open = open
        self.start = start
        self.years = years ?? 1900...Calendar(identifier: .gregorian).component(.year, from: Date())
        self.clear = clear
        self.yearAlways = yearAlways
        self.separator = separator
        self.said = said
        self.held = held
    }

    public var body: some View {
        if inSection { setting } else { field }
    }

    private var setting: some View {
        SettingRow(label, waiting: said.waiting, only: said.only, problem: said.problem, line: said.line, separator: separator) {
            Button(action: toggle) {
                HStack(spacing: Cockpit.Space.s2) {
                    Text(day?.words ?? empty)
                        .cockpit(.body)
                        .foregroundStyle(day == nil ? Cockpit.Color.textTertiary : enabled ? Cockpit.Color.text : Cockpit.Color.textSecondary)
                        .cockpitLines(1)
                    FieldRowCaret(open: open)
                }
                .frame(minHeight: Cockpit.Size.target)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressedDim())
            .accessibilityLabel(label)
            .accessibilityValue(day?.words ?? empty)
        } held: {
            if open {
                DateWheel(day: wheelDay, years: years)
                foot.padding(.leading, -(Cockpit.Space.s4 - Cockpit.Space.s2)).padding(.trailing, -Cockpit.Space.s3)
            }
            if let held { held }
        }
    }

    private var field: some View {
        VStack(spacing: 0) {
            line
            if open {
                Rectangle()
                    .fill(Cockpit.Color.rule)
                    .frame(height: Cockpit.pixelRule)
                    .padding(.leading, Cockpit.Space.s4)
                DateWheel(day: wheelDay, years: years)
                    .padding(.horizontal, Cockpit.Space.s2)
                foot
            }
        }
        .fieldRowBox(lit: enabled && open)
        .clipShape(RoundedRectangle(cornerRadius: Cockpit.Radius.sm, style: .continuous))
    }

    private var line: some View {
        Button(action: toggle) {
            FieldRowLine(label: label) {
                HStack(spacing: Cockpit.Space.s2) {
                    Text(day?.words ?? empty)
                        .cockpit(.body)
                        .foregroundStyle(day == nil ? Cockpit.Color.textTertiary : enabled ? Cockpit.Color.text : Cockpit.Color.textSecondary)
                        .cockpitLines(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    FieldRowCaret(open: open)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(Cockpit.Pressable(forced: forced) { label, state in
            label.background {
                if let state {
                    UnevenRoundedRectangle(topLeadingRadius: Cockpit.Radius.sm, bottomLeadingRadius: open ? 0 : Cockpit.Radius.sm,
                                           bottomTrailingRadius: open ? 0 : Cockpit.Radius.sm, topTrailingRadius: Cockpit.Radius.sm,
                                           style: .continuous)
                        .fill(RowChrome<EmptyView>.color(state))
                }
            }
            .animation(.easeOut(duration: Cockpit.Duration.instant), value: state)
        })
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(day?.words ?? empty)
        .accessibilityAddTraits(.isButton)
    }

    @ViewBuilder private var foot: some View {
        if yearAlways {
            HStack { clearButton; Spacer(minLength: 0) }
                .padding(.leading, Cockpit.Space.s4 - Cockpit.Space.s2)
                .padding(.bottom, clear == nil ? 0 : Cockpit.Space.s2)
        } else {
            switchedFoot
        }
    }

    private var switchedFoot: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Cockpit.Space.s3) {
                clearButton
                Spacer(minLength: 0)
                yearSwitch.fixedSize()
            }
            VStack(alignment: .leading, spacing: 0) {
                yearSwitch.padding(.leading, Cockpit.Space.s2)
                clearButton
            }
        }
        .padding(.leading, Cockpit.Space.s4 - Cockpit.Space.s2)
        .padding(.trailing, Cockpit.Space.s3)
        .padding(.bottom, Cockpit.Space.s2)
    }

    @ViewBuilder private var clearButton: some View {
        if let clear {
            Button(clear) {
                withAnimation(motion) {
                    day = nil
                    open = false
                }
            }
            .buttonStyle(.cockpit(.plain, size: .small))
            .accessibilityLabel("\(clear) \(label.lowercased())")
        }
    }

    private var yearSwitch: some View {
        Toggle("Year", isOn: Binding(get: { day?.year != nil }, set: setYear))
            .toggleStyle(.cockpit)
    }

    private var wheelDay: Binding<Day> {
        Binding(get: { day ?? start ?? .today }, set: { day = $0 })
    }

    private var motion: Animation? { reduceMotion ? nil : Cockpit.Ease.out(Cockpit.Duration.base) }

    private func toggle() {
        withAnimation(motion) {
            if !open, day == nil {
                var first = start ?? .today
                if yearAlways, first.year == nil { first.year = years.upperBound }
                day = first.held
            }
            open.toggle()
        }
    }

    private func setYear(_ on: Bool) {
        guard var shown = day else { return }
        if on {
            shown.year = min(max(lastYear ?? years.upperBound, years.lowerBound), years.upperBound)
        } else {
            lastYear = shown.year
            shown.year = nil
        }
        day = shown.held
    }
}

private enum WheelColumn {
    case day, month, year

    var name: String {
        switch self {
        case .day: "Day"
        case .month: "Month"
        case .year: "Year"
        }
    }

    var width: CGFloat {
        switch self {
        case .day: 56
        case .month: 148
        case .year: 80
        }
    }

    static func shown(_ day: DateRow.Day) -> [WheelColumn] { day.year == nil ? [.day, .month] : [.day, .month, .year] }
}

private struct WheelMeasure {
    let typeSize: DynamicTypeSize
    let columns: [WheelColumn]
    let width: CGFloat

    private var grown: [CGFloat] { columns.map { Cockpit.scaled($0.width, relativeTo: .title3, at: typeSize) } }
    private var fit: CGFloat { min(1, width / max(1, grown.reduce(0, +))) }

    var widths: [CGFloat] { grown.map { $0 * fit } }
    var fontSize: CGFloat { Cockpit.scaled(Cockpit.Style.phoneTitle2.size, relativeTo: .title3, at: typeSize) * fit }
    var row: CGFloat { Cockpit.scaled(34, relativeTo: .title3, at: typeSize) * fit }
    var height: CGFloat { max(216, row * 3) }

    static func rows(_ column: WheelColumn, of day: DateRow.Day, years: ClosedRange<Int>) -> Int {
        switch column {
        case .day: DateRow.Day.days(in: day.month, year: day.year)
        case .month: 12
        case .year: years.count
        }
    }

    static func words(_ column: WheelColumn, row: Int, years: ClosedRange<Int>) -> String {
        switch column {
        case .day: "\(row + 1)"
        case .month: DateRow.Day.months[row]
        case .year: "\(years.lowerBound + row)"
        }
    }

    static func row(_ column: WheelColumn, of day: DateRow.Day, years: ClosedRange<Int>) -> Int {
        switch column {
        case .day: day.day - 1
        case .month: day.month - 1
        case .year: (day.year ?? years.upperBound) - years.lowerBound
        }
    }

    static func turned(_ day: DateRow.Day, _ column: WheelColumn, to row: Int, years: ClosedRange<Int>) -> DateRow.Day {
        var day = day
        switch column {
        case .day: day.day = row + 1
        case .month: day.month = row + 1
        case .year: day.year = years.lowerBound + row
        }
        return day.held
    }
}

#if os(iOS)
private struct DateWheel: UIViewRepresentable {
    @Binding var day: DateRow.Day
    let years: ClosedRange<Int>
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.isEnabled) private var enabled

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIPickerView {
        let picker = WheelView()
        picker.dataSource = context.coordinator
        picker.delegate = context.coordinator
        picker.widened = { [weak coordinator = context.coordinator] picker in
            picker.reloadAllComponents()
            coordinator?.select(picker)
        }
        picker.setContentHuggingPriority(.defaultLow, for: .horizontal)
        picker.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return picker
    }

    func updateUIView(_ picker: UIPickerView, context: Context) {
        let coordinator = context.coordinator
        let loaded = coordinator.loaded
        coordinator.day = day
        coordinator.years = years
        coordinator.typeSize = typeSize
        coordinator.turn = { day = $0 }
        picker.isUserInteractionEnabled = enabled
        picker.alpha = enabled ? 1 : Cockpit.Opacity.disabled
        let now = coordinator.loaded
        if loaded.0 != now.0 || loaded.1 != now.1 {
            picker.reloadAllComponents()
        } else if loaded.2 != now.2 || loaded.3 != now.3 {
            picker.reloadComponent(0)
        }
        coordinator.select(picker)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UIPickerView, context: Context) -> CGSize? {
        let width = proposal.width ?? 320
        return CGSize(width: width, height: WheelMeasure(typeSize: typeSize, columns: WheelColumn.shown(day),
                                                         width: width - Cockpit.Space.s4).height)
    }

    final class Coordinator: NSObject, UIPickerViewDataSource, UIPickerViewDelegate, UIPickerViewAccessibilityDelegate {
        var day = DateRow.Day(month: 1, day: 1)
        var years = 1900...2000
        var typeSize = DynamicTypeSize.large
        var turn: (DateRow.Day) -> Void = { _ in }

        var loaded: ([WheelColumn], DynamicTypeSize, Int, Int?) { (columns, typeSize, day.month, day.year) }
        private var columns: [WheelColumn] { WheelColumn.shown(day) }

        private func measure(_ picker: UIPickerView) -> WheelMeasure {
            WheelMeasure(typeSize: typeSize, columns: columns,
                         width: picker.bounds.width > 0 ? picker.bounds.width - Cockpit.Space.s4 : .greatestFiniteMagnitude)
        }

        func select(_ picker: UIPickerView) {
            for (index, column) in columns.enumerated() where index < picker.numberOfComponents {
                let row = WheelMeasure.row(column, of: day, years: years)
                if picker.selectedRow(inComponent: index) != row { picker.selectRow(row, inComponent: index, animated: false) }
            }
        }

        func numberOfComponents(in pickerView: UIPickerView) -> Int { columns.count }

        func pickerView(_ pickerView: UIPickerView, numberOfRowsInComponent component: Int) -> Int {
            WheelMeasure.rows(columns[component], of: day, years: years)
        }

        func pickerView(_ pickerView: UIPickerView, widthForComponent component: Int) -> CGFloat {
            measure(pickerView).widths[component]
        }

        func pickerView(_ pickerView: UIPickerView, rowHeightForComponent component: Int) -> CGFloat { measure(pickerView).row }

        func pickerView(_ pickerView: UIPickerView, viewForRow row: Int, forComponent component: Int, reusing view: UIView?) -> UIView {
            let label = (view as? UILabel) ?? UILabel()
            label.text = WheelMeasure.words(columns[component], row: row, years: years)
            label.font = .systemFont(ofSize: measure(pickerView).fontSize, weight: .medium)
            label.textColor = UIColor(Cockpit.Color.text)
            label.textAlignment = .center
            label.adjustsFontSizeToFitWidth = true
            label.minimumScaleFactor = 0.5
            return label
        }

        func pickerView(_ pickerView: UIPickerView, didSelectRow row: Int, inComponent component: Int) {
            turn(WheelMeasure.turned(day, columns[component], to: row, years: years))
        }

        func pickerView(_ pickerView: UIPickerView, accessibilityLabelForComponent component: Int) -> String? {
            columns[component].name
        }
    }
}
private final class WheelView: UIPickerView {
    var widened: ((UIPickerView) -> Void)?
    private var laidWidth: CGFloat = 0

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width != laidWidth else { return }
        laidWidth = bounds.width
        widened?(self)
    }
}
#else
private struct DateWheel: View {
    @Binding var day: DateRow.Day
    let years: ClosedRange<Int>
    @State private var width: CGFloat = 0
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        GeometryReader { proxy in
            let columns = WheelColumn.shown(day)
            let measure = WheelMeasure(typeSize: typeSize, columns: columns, width: proxy.size.width - Cockpit.Space.s4)
            let widths = measure.widths
            ZStack {
                RoundedRectangle(cornerRadius: Cockpit.Radius.sm, style: .continuous)
                    .fill(Cockpit.Color.selection)
                    .frame(height: measure.row)
                HStack(spacing: 0) {
                    ForEach(Array(columns.enumerated()), id: \.offset) { index, column in
                        cylinder(column, measure: measure).frame(width: widths[index])
                    }
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .frame(height: WheelMeasure(typeSize: typeSize, columns: WheelColumn.shown(day),
                                    width: (width > 0 ? width : 320) - Cockpit.Space.s4).height)
        .clipped()
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(day.words)
    }

    private func cylinder(_ column: WheelColumn, measure: WheelMeasure) -> some View {
        let radius = measure.height / 2
        let chosen = WheelMeasure.row(column, of: day, years: years)
        let count = WheelMeasure.rows(column, of: day, years: years)
        return ZStack {
            ForEach(-4...4, id: \.self) { step in
                let angle = Double(step) * Double(measure.row / radius)
                if chosen + step >= 0, chosen + step < count, abs(angle) < .pi / 2 {
                    Text(WheelMeasure.words(column, row: chosen + step, years: years))
                        .font(.system(size: measure.fontSize, weight: .medium))
                        .foregroundStyle(Cockpit.Color.text)
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                        .padding(.horizontal, 4)
                        .scaleEffect(x: 0.9 + 0.1 * cos(angle), y: cos(angle))
                        .opacity(step == 0 ? 1 : 0.55 * cos(angle) * cos(angle))
                        .offset(y: radius * sin(angle))
                }
            }
        }
    }
}
#endif
