#if os(macOS)
import SwiftUI
@testable import Cockpit

@MainActor let iconSheet = Sheet("icon", ios: 430, mac: 430) {
    Specimen("Regular") {
        LazyVGrid(columns: Array(repeating: GridItem(.fixed(44), spacing: 4), count: 8), alignment: .leading, spacing: 10) {
            ForEach(Cockpit.Icon.allCases, id: \.self) { meaning in
                VStack(spacing: 3) {
                    Icon(meaning).foregroundStyle(Cockpit.Color.text)
                    Text(meaning.rawValue).font(.system(size: 7, design: .monospaced)).foregroundStyle(Cockpit.Color.textTertiary).lineLimit(1).minimumScaleFactor(0.6)
                }
            }
        }
    }
    Specimen("Fill") {
        LazyVGrid(columns: Array(repeating: GridItem(.fixed(44), spacing: 4), count: 8), alignment: .leading, spacing: 10) {
            ForEach(Cockpit.Icon.allCases.filter(\.hasFill), id: \.self) { meaning in
                VStack(spacing: 3) {
                    Icon(meaning, weight: .fill).foregroundStyle(Cockpit.Color.text)
                    Text(meaning.rawValue).font(.system(size: 7, design: .monospaced)).foregroundStyle(Cockpit.Color.textTertiary).lineLimit(1).minimumScaleFactor(0.6)
                }
            }
        }
    }
    Specimen("Sizes xs sm md lg xl · text, secondary, tertiary") {
        HStack(alignment: .center, spacing: 14) {
            ForEach([Cockpit.IconSize.xs, .sm, .md, .lg, .xl], id: \.points) { size in Icon(.sleep, size: size) }
            Icon(.mail, size: .lg).foregroundStyle(Cockpit.Color.textSecondary)
            Icon(.ai, size: .lg).foregroundStyle(Cockpit.Color.textTertiary)
            Icon(.today, size: .xl)
            Icon(.today, weight: .fill, size: .xl)
            Icon(.streams, size: .xl)
        }
        .foregroundStyle(Cockpit.Color.text)
    }
}
private extension Cockpit.Icon {
    var hasFill: Bool {
        switch drawing {
        case let .phosphor(_, fill): fill != nil
        case let .own(_, solid): solid != nil
        }
    }
}
#endif
