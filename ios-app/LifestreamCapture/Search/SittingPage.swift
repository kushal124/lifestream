import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct SittingPage: View {
    let sitting: SearchModel.Sitting
    @ObservedObject private var home = HomeToday.shared

    var body: some View {
        OnePage(sitting.title) {
            VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                Text(sitting.title)
                    .cockpit(.title1)
                    .foregroundStyle(Cockpit.Color.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text(facts)
                    .cockpit(.subhead)
                    .foregroundStyle(Cockpit.Color.textSecondary)
            }
            if !sitting.windows.isEmpty {
                VStack(alignment: .leading, spacing: Cockpit.Gap.group) {
                    SectionLabel(sitting.windowsLine ?? "Windows")
                    Card(group: true, flat: true) {
                        ForEach(Array(sitting.windows.enumerated()), id: \.element.ref) { index, window in
                            ListRow(window.title, excerpt: HitWords.excerpt(window.line), leading: .tile(HitWords.icon("screen")),
                                    stamp: HitWords.clock(window.when), chevron: false, separator: index < sitting.windows.count - 1, action: {
                                window.opens.flatMap { LifeRoute.opening($0, family: "screen") }.map { AppNavigation.shared.push($0) }
                            })
                            .accessibilityIdentifier("search.sitting.window.\(index)")
                        }
                    }
                }
            }
            Button("Open the day") {
                LifeRoute.opening(sitting.opens, family: nil).map { AppNavigation.shared.push($0) }
            }
            .buttonStyle(.cockpit(.secondary))
            .accessibilityIdentifier("search.sitting.day")
        }
        .accessibilityIdentifier("search.sitting")
    }

    private var facts: String {
        [SearchWords.family("screen").label, HitWords.when(sitting.when, today: home.today, dated: true)].compactMap { $0 }.joined(separator: Words.dot)
    }
}
