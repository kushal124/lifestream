import SwiftUI

public struct DayRow: View {
    public enum Kind {
        case item(icon: Cockpit.Icon, name: String, detail: String? = nil, words: [DayWord] = [], count: Count? = nil,
                  quiet: Bool = false)
        case hour(names: String, fewer: [String] = [], count: Count? = nil, open: Bool)
        case move(icon: Cockpit.Icon, words: String, more: String? = nil, names: String? = nil, length: String,
                  open: Bool? = nil)
        case now(updated: String?)
        case plan(title: String, facts: String, length: String? = nil)
        case allDay(title: String, facts: String)
        case divider(date: String)
        case dayEnd(next: String)
    }

    public enum Count {
        case text(String)
        case runs([ContactRun])

        var said: String {
            switch self {
            case let .text(words): Spoken.read(words)
            case let .runs(runs): runs.map(\.said).joined(separator: ", ")
            }
        }
    }

    let kind: Kind
    let time: String?
    let rail: DayRail
    let nested: Bool
    let selected: Bool
    let action: (() -> Void)?
    var forced: RowHighlight?
    @Environment(\.dynamicTypeSize) private var typeSize

    public init(_ kind: Kind, time: String?, rail: DayRail = .through, nested: Bool = false, selected: Bool = false,
                action: (() -> Void)? = nil) {
        self.kind = kind
        self.time = time
        self.rail = rail
        self.nested = nested
        self.selected = selected
        self.action = action
    }

    public var body: some View {
        let measure = DayMeasure(size: typeSize)
        Group {
            if let action {
                Button(action: action) { face(measure) }
                    .buttonStyle(DayPress(selected: selected, forced: forced))
            } else {
                DayFill(highlight: forced ?? (selected ? .selected : nil)) { face(measure) }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(said)
        .accessibilityValue(opened.map { $0 ? "Expanded" : "Collapsed" } ?? "")
        .accessibilityAddTraits(traits)
    }


    @ViewBuilder private func face(_ m: DayMeasure) -> some View {
        switch kind {
        case let .item(icon, name, detail, words, count, quiet):
            itemFace(m, icon: icon, name: name, words: (detail.map { [.quiet($0)] } ?? []) + words, count: count, quiet: quiet)
        case let .hour(names, fewer, count, open):
            hourFace(m, names: names, fewer: fewer, count: count, open: open)
        case let .plan(title, facts, length):
            planFace(m, title: title, facts: facts, length: length)
        case let .allDay(title, facts):
            allDayFace(m, title: title, facts: facts)
        case let .now(updated):
            nowFace(m, updated: updated)
        case let .move(icon, words, more, names, length, open):
            moveFace(m, icon: icon, words: words, more: more, names: names, length: length, open: open)
        case let .divider(date):
            dividerFace(m, date: date)
        case let .dayEnd(next):
            oneLine(m, mark: nil) {
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    Text("The day ends")
                        .cockpit(Cockpit.Style.iosSubhead)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .fixedSize()
                    Text(" \u{00B7} ")
                        .cockpit(Cockpit.Style.iosSubhead)
                        .foregroundStyle(Cockpit.Color.textTertiary)
                        .fixedSize()
                    CutText(text: "\(next) begins", style: Cockpit.Style.iosSubhead, tone: Cockpit.Color.textTertiary)
                }
            }
        }
    }

    private func planFace(_ m: DayMeasure, title: String, facts: String, length: String?) -> some View {
        let first = m.timeLine + m(29)
        let second = first + m(22)
        let centre = first - m.capHeight(Cockpit.Style.phoneRowTitle) / 2
        return ZStack(alignment: .topLeading) {
            Color.clear.frame(height: second + m(17))
            if let time {
                DayTime(time: time, tone: Cockpit.Color.textSecondary, measure: m, stackedAt: DayLattice.lead)
                    .onBaseline(m.stacked ? m(12, .caption) : first)
            }
            PlanRing().padding(.leading, DayLattice.rail - DayLattice.railWidth / 2).onCentre(centre)
            HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s4) {
                Text(title).cockpit(Cockpit.Style.phoneRowTitle).foregroundStyle(Cockpit.Color.text).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let length { countView(.text(length), tone: Cockpit.Color.textTertiary) }
            }
            .column(DayLattice.lead)
            .onBaseline(first)
            WholeFacts(facts: facts).column(DayLattice.lead).onBaseline(second)
        }
        .frame(maxWidth: .infinity)
        .dayRail(rail, mark: centre)
        .contentShape(Rectangle())
    }

    private func plainLine<Words: View>(_ m: DayMeasure, column: CGFloat, style: Cockpit.TextStyle,
                                        @ViewBuilder words: () -> Words) -> some View {
        let centre = m.timeLine + m(20)
        return ZStack(alignment: .topLeading) {
            Color.clear.frame(height: m.timeLine + m(40))
            if let time {
                let shown = DayTime(time: time, measure: m, stackedAt: column)
                if m.stacked { shown.onBaseline(m(12, .caption)) } else { shown.onCapCentre(centre, Cockpit.Style.phoneTime, m) }
            }
            words().column(column, trailing: DayLattice.beforeCaret).onCapCentre(centre, style, m)
        }
        .frame(maxWidth: .infinity)
        .dayRail(rail, mark: centre)
        .contentShape(Rectangle())
    }

    private func itemFace(_ m: DayMeasure, icon: Cockpit.Icon, name: String, words: [DayWord], count: Count?, quiet: Bool) -> some View {
        let style = Cockpit.Style.phoneRowTitle
        return plainLine(m, column: DayLattice.name + (nested ? DayLattice.step : 0), style: style) {
            HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s4) {
                HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s2) {
                    Icon(icon, size: .sm)
                        .foregroundStyle(quiet ? Cockpit.Color.textTertiary : Cockpit.Color.textSecondary)
                        .onCaps(style, m)
                    HStack(alignment: .firstTextBaseline, spacing: 0) {
                        Text(name).cockpit(style)
                            .foregroundStyle(quiet ? Cockpit.Color.textSecondary : Cockpit.Color.text)
                            .lineLimit(1)
                            .layoutPriority(1)
                        if !words.isEmpty { WordsLine(words: words, led: true) }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if let count { countView(count, tone: Cockpit.Color.textSecondary).capsWith(style, own: Cockpit.Style.phoneData, m) }
            }
        }
    }

    private func allDayFace(_ m: DayMeasure, title: String, facts: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s3) {
            Icon(.calendarEvent, size: .sm).foregroundStyle(Cockpit.Color.textTertiary)
            VStack(alignment: .leading, spacing: m(2)) {
                Text(title)
                    .cockpit(Cockpit.Style.phoneRowTitle)
                    .foregroundStyle(Cockpit.Color.text)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Text(facts)
                    .cockpit(Cockpit.Style.iosSubhead)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.leading, DayLattice.timeStart)
        .padding(.trailing, DayLattice.trailing)
        .padding(.vertical, m(10))
        .frame(maxWidth: .infinity)
        .dayRail(rail)
        .contentShape(Rectangle())
    }

    private func oneLine<Words: View>(_ m: DayMeasure, mark: AnyView?, trailing: CGFloat = DayLattice.beforeCaret,
                                      style: Cockpit.TextStyle = Cockpit.Style.iosSubhead,
                                      timeTone: Color = Cockpit.Color.textTertiary, timeWeight: Font.Weight? = nil,
                                      @ViewBuilder words: () -> Words) -> some View {
        let baseline = m.timeLine + m(32)
        let height = baseline + m(20)
        let centre = Self.oneLineCentre(m, style)
        return ZStack(alignment: .topLeading) {
            Color.clear.frame(height: height)
            if let time {
                let shown = DayTime(time: time, tone: timeTone, weight: timeWeight, measure: m, stackedAt: DayLattice.lead)
                if m.stacked { shown.onBaseline(m(12, .caption)) } else { shown.onCapCentre(centre, Cockpit.Style.phoneTime, m) }
            }
            if let mark { mark.padding(.leading, DayLattice.rail - DayLattice.railWidth / 2).onCentre(centre) }
            words().column(DayLattice.lead, trailing: trailing).onBaseline(baseline)
        }
        .frame(maxWidth: .infinity)
        .dayRail(rail, mark: centre)
        .contentShape(Rectangle())
    }

    private static func oneLineCentre(_ m: DayMeasure, _ style: Cockpit.TextStyle) -> CGFloat {
        m.timeLine + m(32) - m.capHeight(style) / 2
    }

    private func hourFace(_ m: DayMeasure, names: String, fewer: [String], count: Count?, open: Bool) -> some View {
        let style = Cockpit.Style.phoneRowTitle
        return plainLine(m, column: DayLattice.name, style: style) {
            HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s4) {
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    LeadCaret(open: open).onCaps(style, m)
                    ViewThatFits(in: .horizontal) {
                        ForEach([names] + fewer, id: \.self) { line in
                            Text(line)
                                .cockpit(style)
                                .foregroundStyle(Cockpit.Color.textSecondary)
                                .lineLimit(1)
                                .fixedSize(horizontal: true, vertical: false)
                        }
                        CutText(text: fewer.last ?? names, style: style, tone: Cockpit.Color.textSecondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if let count { countView(count, tone: Cockpit.Color.textSecondary).capsWith(style, own: Cockpit.Style.phoneData, m) }
            }
        }
    }

    private func moveFace(_ m: DayMeasure, icon: Cockpit.Icon, words: String, more: String?, names: String?,
                          length: String, open: Bool?) -> some View {
        let centre = Self.oneLineCentre(m, Cockpit.Style.iosSubhead)
        return oneLine(m, mark: AnyView(MoveMark(icon: icon)), trailing: DayLattice.beforeCaret) {
            HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s4) {
                WordsLine(words: [.text(words)] + (more.map { [.quiet($0)] } ?? []) + (names.map { [.text($0)] } ?? []))
                    .layoutPriority(1)
                Spacer(minLength: 0)
                Text(length)
                    .cockpit(Cockpit.Style.iosSubhead)
                    .monospacedDigit()
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .lineLimit(1)
                    .fixedSize()
                    .layoutPriority(2)
            }
        }
        .overlay(alignment: .topLeading) {
            if let open { DayCaret(open: open).onCentre(centre).frame(maxHeight: .infinity, alignment: .top) }
        }
    }

    private func nowFace(_ m: DayMeasure, updated: String?) -> some View {
        let style = Cockpit.Style.phoneRowTitle
        return oneLine(m, mark: AnyView(NowRing()), style: style, timeTone: Cockpit.Color.accent, timeWeight: .semibold) {
            HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s4) {
                nowWord.frame(maxWidth: .infinity, alignment: .leading)
                if let updated { countView(.text("Updated " + updated), tone: Cockpit.Color.textTertiary) }
            }
        }
    }

    private var nowWord: some View {
        Text("Now").cockpit(Cockpit.Style.phoneRowTitle).foregroundStyle(Cockpit.Color.accent)
    }

    private func dividerFace(_ m: DayMeasure, date: String) -> some View {
        let baseline = m(23)
        return ZStack(alignment: .topLeading) {
            Color.clear.frame(height: baseline)
            Text(date)
                .cockpit(Cockpit.Style.iosSubhead)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .lineLimit(1)
                .fixedSize()
                .column(DayLattice.timeStart)
                .onBaseline(baseline)
        }
        .frame(maxWidth: .infinity)
        .dayRail(rail, opensFrom: baseline - m(16))
    }

    private func countView(_ count: Count, tone: Color) -> some View {
        Group {
            switch count {
            case let .text(words):
                Text(words)
                    .cockpit(Cockpit.Style.iosSubhead)
                    .monospacedDigit()
                    .foregroundStyle(tone)
                    .lineLimit(1)
                    .fixedSize()
            case let .runs(runs):
                ContactRuns(runs: runs, glyph: .xs, tone: tone)
            }
        }
    }


    private var opened: Bool? {
        switch kind {
        case let .hour(_, _, _, open): open
        case let .move(_, _, _, _, _, open): open
        default: nil
        }
    }

    private var traits: AccessibilityTraits {
        var traits: AccessibilityTraits = action == nil ? [] : .isButton
        if selected { traits.formUnion(.isSelected) }
        if case .divider = kind { traits.formUnion(.isHeader) }
        return traits
    }

    private var said: String {
        switch kind {
        case let .item(_, name, detail, words, count, _):
            return Spoken.join(time, name, detail, words.compactMap(\.said).joined(separator: ", "), count?.said)
        case let .hour(names, _, count, _):
            return Spoken.join(time, names, count?.said)
        case let .move(_, words, more, names, length, _):
            return Spoken.join(time, words, more, names, Spoken.read(length))
        case let .now(updated):
            return Spoken.join("Now", time, updated.map { "updated " + $0 })
        case let .plan(title, facts, length):
            return Spoken.join("Planned", time, title, Spoken.read(facts), length.map(Spoken.read))
        case let .allDay(title, facts):
            return Spoken.join("All day", title, facts)
        case let .divider(date):
            return Spoken.join(time, date)
        case let .dayEnd(next):
            return Spoken.join(time, "The day ends", "\(next) begins")
        }
    }
}

private struct NowRing: View {
    var body: some View {
        ZStack {
            RailGround()
            BreathRing(color: Cockpit.Color.accent, scale: 1.5, from: 0.6)
                .frame(width: 11 - Cockpit.Stroke.line, height: 11 - Cockpit.Stroke.line)
            Circle().strokeBorder(Cockpit.Color.accent, lineWidth: Cockpit.Stroke.line)
            Circle().fill(Cockpit.Color.accent).frame(width: DayLattice.nowDot, height: DayLattice.nowDot)
        }
        .frame(width: DayLattice.ring, height: DayLattice.ring)
        .frame(width: DayLattice.railWidth, height: DayLattice.railWidth)
    }
}

private struct PlanRing: View {
    var body: some View {
        Circle()
            .fill(Cockpit.Color.canvas)
            .overlay {
                Circle().strokeBorder(Cockpit.Color.textTertiary, style: StrokeStyle(lineWidth: Cockpit.Stroke.line, dash: Cockpit.Dash.plan))
            }
            .frame(width: DayLattice.ring, height: DayLattice.ring)
            .frame(width: DayLattice.railWidth, height: DayLattice.railWidth)
    }
}

private struct MoveMark: View {
    let icon: Cockpit.Icon

    var body: some View {
        ZStack {
            RailGround().frame(width: DayLattice.railWidth, height: DayLattice.railWidth)
            Icon(icon, size: .sm).foregroundStyle(Cockpit.Color.textTertiary)
        }
        .frame(width: DayLattice.railWidth, height: DayLattice.railWidth)
    }
}

struct WholeFacts: View {
    let facts: String
    var tone: Color = Cockpit.Color.textSecondary

    var body: some View {
        let parts = facts.components(separatedBy: " · ")
        ViewThatFits(in: .horizontal) {
            ForEach((1...parts.count).reversed(), id: \.self) { count in
                Text(parts.prefix(count).joined(separator: " · "))
                    .cockpit(Cockpit.Style.iosSubhead)
                    .foregroundStyle(tone)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
            }
            CutText(text: parts[0], style: Cockpit.Style.iosSubhead, tone: tone)
        }
    }
}
