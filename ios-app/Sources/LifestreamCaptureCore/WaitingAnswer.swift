import Foundation
import HomeLink

public struct WaitingAnswer: PageAnswer {
    public static let route = HomeLink.Pages.AgentsWaiting.route
    public static let key = HomeLink.PageKey(route, [:])

    public let page: HomeLink.Pages.AgentsWaiting
    public let listed: HomeLink.AgentsWaiting

    public var position: String { page.position }

    public init(from decoder: Decoder) throws {
        page = try HomeLink.Pages.AgentsWaiting(from: decoder)
        listed = try HomeLink.AgentsWaiting(from: decoder)
    }
}
