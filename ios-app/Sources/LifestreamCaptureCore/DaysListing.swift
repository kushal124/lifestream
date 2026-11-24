import Foundation
import HomeLink

public struct DaysListing: Sendable, Equatable {
    public let opening: String
    public let days: [String]
    public let written: Set<String>
    public let totals: [String: Int]

    public init?(_ pages: [HomeLink.Pages.Days]) {
        guard let head = pages.first else { return nil }
        let listed = pages.flatMap(\.days)
        opening = head.opening
        days = listed.map(\.day)
        written = Set(days)
        totals = Dictionary(listed.map { ($0.day, $0.counts.total) }, uniquingKeysWith: max)
    }

    public var first: String? { days.first }
}
