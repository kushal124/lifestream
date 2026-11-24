import Cockpit
import SwiftUI

struct RecentSearches: View {
    let words: [String]
    let pick: (String) -> Void
    let clear: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Gap.group) {
            HStack(alignment: .firstTextBaseline) {
                SectionLabel("Recent")
                Button("Clear", action: clear)
                    .buttonStyle(.cockpit(.plain, size: .small))
                    .accessibilityIdentifier("search.recent.clear")
            }
            Card(group: true, flat: true) {
                ForEach(Array(words.enumerated()), id: \.element) { index, query in
                    ListRow(query, leading: .icon(.time), separator: index < words.count - 1, action: { pick(query) })
                        .accessibilityIdentifier("search.recent.\(index)")
                }
            }
        }
    }
}
