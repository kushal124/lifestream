import Cockpit
import LifestreamCaptureCore
import SwiftUI

struct DayDate: View {
    let day: String
    let today: String

    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .largeTitle) private var shrunk: CGFloat = Cockpit.Style.iosDisplay.size * 0.9

    var body: some View {
        let full = Words.dayTitle(day, today: today)
        ViewThatFits(in: .horizontal) {
            line(full)
            line(full, shrunk: true)
            line(Self.short(full))
            line(Self.short(full), shrunk: true)
        }
        .minimumScaleFactor(typeSize.isAccessibilitySize ? 0.6 : 1)
    }

    private func line(_ words: String, shrunk small: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s1) {
            Group {
                if small {
                    Text(words)
                        .font(.system(size: shrunk, weight: .semibold))
                        .tracking(Cockpit.Style.iosDisplay.tracking * 0.9)
                } else {
                    Text(words).cockpit(.display)
                }
            }
            .foregroundStyle(Cockpit.Color.text)
            .lineLimit(1)
            Icon(.expand, size: .md)
                .foregroundStyle(Cockpit.Color.textTertiary)
        }
    }

    private static func short(_ title: String) -> String {
        var words = title.split(separator: " ").map(String.init)
        if words.count > 1 { words[1] = String(words[1].prefix(3)) }
        return words.joined(separator: " ")
    }
}

struct DayRootTitle: View {
    static let hint = "Shows every day"

    let day: String
    let word: String?
    let today: String
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            DayDate(day: day, today: today)
                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .dayTitled(day: day, word: word, today: today)
        .foldsOnRootLine()
    }
}

extension EnvironmentValues {
    @Entry var dayHeadIndent: CGFloat = 0
}

struct DayHead: View {
    let day: String
    let word: String?
    let today: String
    let open: () -> Void

    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.dayHeadIndent) private var indent

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 0) {
                Text(line)
                    .cockpit(Cockpit.Style.iosBody)
                    .foregroundStyle(Cockpit.Color.textSecondary)
            }
            .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
            .padding(.leading, indent)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("day.top")
        .padding(.horizontal, Cockpit.Gap.edge)
    }

    private var line: String {
        [Words.weekdayName(ofDay: day), word].compactMap { $0 }.joined(separator: Words.dot)
    }
}

private extension View {
    func dayTitled(day: String, word: String?, today: String) -> some View {
        accessibilityElement(children: .ignore)
            .accessibilityLabel([Words.longDay(day, today: today), word].compactMap { $0 }.joined(separator: ", "))
            .accessibilityHint(DayRootTitle.hint)
            .accessibilityAddTraits([.isHeader, .isButton])
            .accessibilityIdentifier("day.title")
    }
}
