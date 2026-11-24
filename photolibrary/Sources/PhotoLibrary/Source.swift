import Foundation

protocol PhotoSource: Sendable {
    var access: PhotoAccess { get }
    func requestAccess() async -> PhotoAccess
    func count() async throws -> Int
    func token() async throws -> Data
    func changes(since token: Data, limit: Int) async throws -> [PhotoChange]?
    func identifiers() async throws -> [String]
    func creationDates() async throws -> [Date?]
    func snapshots(of ids: [String]) async throws -> [PhotoSnapshot]
    func file(of id: String, resource: PhotoResource, network: Bool, most: Int64, to url: URL) async -> Fetched
    func observe(_ changed: @escaping @Sendable () -> Void)
}

struct PhotoChange: Sendable {
    var upserted: [String]
    var deleted: [String]
    var token: Data
}
