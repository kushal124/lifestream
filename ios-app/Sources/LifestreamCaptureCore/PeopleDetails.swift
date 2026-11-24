import Foundation
import HomeLink

public enum PeopleDetails {
    public typealias Profile = HomeLink.Person.Details.Profile

    public static func networkName(_ network: String) -> String? {
        ["instagram": "Instagram", "x": "X", "linkedin": "LinkedIn", "facebook": "Facebook", "github": "GitHub", "site": "Site"][network]
    }

    public static func profileWords(_ profile: Profile, path: Bool = false) -> String {
        if profile.network == "site" { return path ? profile.value : String(profile.value.prefix { $0 != "/" }) }
        return profile.network == "instagram" || profile.network == "x" ? "@" + profile.value : profile.value
    }

    public static func profileHref(_ profile: Profile) -> String {
        let handle = profile.value.addingPercentEncoding(withAllowedCharacters: component) ?? ""
        switch profile.network {
        case "instagram": return "https://www.instagram.com/\(handle)/"
        case "x": return "https://x.com/\(handle)"
        case "linkedin": return "https://www.linkedin.com/in/\(handle)/"
        case "facebook": return "https://www.facebook.com/\(handle)"
        case "github": return "https://github.com/\(handle)"
        default: return "https://" + profile.value
        }
    }

    private static let component = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

    public struct Square: Equatable, Sendable {
        public let x: Int
        public let y: Int
        public let side: Int

        public init(x: Int, y: Int, side: Int) {
            self.x = x
            self.y = y
            self.side = side
        }
    }

    public static let aroundFace = 2.5

    public static func around(_ box: [Double], photo: CGSize, picture: CGSize) -> Square? {
        guard box.count == 4, photo.width > 0 else { return nil }
        let scale = Double(picture.width) / Double(photo.width)
        let (x1, y1, x2, y2) = (box[0] * scale, box[1] * scale, box[2] * scale, box[3] * scale)
        let width = Double(picture.width), height = Double(picture.height)
        let side = min(width, height, aroundFace * max(x2 - x1, y2 - y1)).rounded()
        let hold = { (at: Double, most: Double) in min(max(0, at), max(0, most - side)).rounded() }
        return Square(x: Int(hold((x1 + x2) / 2 - side / 2, width)), y: Int(hold((y1 + y2) / 2 - side / 2, height)), side: Int(side))
    }
}

@MainActor
public final class PhotoPages<Failure: Error>: ObservableObject {
    public typealias Photo = HomeLink.People.Photos.Photo
    public typealias Read = @MainActor (_ after: String?, _ etag: String?) async throws -> HomeLink.Tagged<HomeLink.People.Photos>?

    @Published public private(set) var photos: [Photo] = []
    @Published private var failed: (after: String?, why: Failure)?
    public var failure: Failure? { failed?.why }
    @Published public private(set) var next: String?
    @Published public private(set) var total = 0
    private var landed = false
    private var etag: String?
    private var asking: (after: String?, task: Task<Void, Never>)?

    private let reader: Read
    private let why: (any Error) -> Failure

    public init(read: @escaping Read, failed: @escaping (any Error) -> Failure) {
        reader = read
        why = failed
    }

    public func read() async {
        while let asking {
            await asking.task.value
            if asking.after == nil { return }
        }
        await ask(after: nil)
    }

    public func need(_ count: Int) async {
        guard failure == nil else { return }
        if !landed { await read() }
        while photos.count < count, failure == nil, let next, !Task.isCancelled {
            await ask(after: next)
        }
    }

    public func retry(_ count: Int) async {
        if let failed {
            self.failed = nil
            await ask(after: failed.after)
        }
        await need(count)
    }

    private func ask(after: String?) async {
        if let asking { return await asking.task.value }
        let task = Task { [weak self] in
            await self?.page(after: after)
            self?.asking = nil
        }
        asking = (after, task)
        await task.value
    }

    private func page(after: String?) async {
        do {
            let first = after == nil
            if let page = try await reader(after, first ? etag : nil) {
                photos = first ? page.value.photos : photos + page.value.photos
                next = page.value.next
                total = page.value.total
                if first { etag = page.etag }
            }
            if first { landed = true }
            failed = nil
        } catch is CancellationError {
            return
        } catch {
            failed = (after, why(error))
        }
    }
}
