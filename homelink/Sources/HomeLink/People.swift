import Foundation

extension HomeLink {
    public enum OwnerAction: Sendable, Equatable {
        case people(request: String, PeopleAct)
        case places(request: String, PlaceAct)

        public var request: String {
            switch self {
            case .people(let request, _), .places(let request, _): request
            }
        }

        func body() throws -> Data {
            let (of, request, members): (String, String, [String: Any]) = switch self {
            case let .people(request, act): ("people", request, act.members)
            case let .places(request, act): ("places", request, act.members)
            }
            let body = members.merging(["of": of, "request": request]) { _, own in own }
            return try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .withoutEscapingSlashes])
        }
    }

    public enum PeopleAct: Sendable, Equatable {
        case confirm(Confirm)
        case photo(id: String, square: Data)
        case group(chat: String, quiet: Bool?)
        case undo(act: String)

        var members: [String: Any] {
            switch self {
            case let .confirm(confirm): confirm.members.merging(["kind": "confirm"]) { _, own in own }
            case let .photo(id, square): ["kind": "photo", "id": id, "upload": square.base64EncodedString()]
            case let .group(chat, quiet): ["kind": "group", "chat": chat, "quiet": quiet.map { $0 as Any } ?? NSNull()]
            case let .undo(act): ["kind": "undo", "act": act]
            }
        }
    }

    public enum PlaceAct: Sendable, Equatable {
        case create(name: String, Place.Circle, ids: [String], home: Bool? = nil)
        case edit(slug: String, PlaceFields)
        case addCircle(slug: String, Place.Circle)
        case remove(slug: String)
        case hide(latitude: Double, longitude: Double)
        case unhide(key: String)

        var members: [String: Any] {
            switch self {
            case let .create(name, circle, ids, home):
                circle.members.merging(["kind": "create", "name": name, "ids": ids]) { _, own in own }
                    .merging(home.map { ["home": $0 as Any] } ?? [:]) { _, own in own }
            case let .edit(slug, fields): fields.members.merging(["kind": "edit", "slug": slug]) { _, own in own }
            case let .addCircle(slug, circle): circle.members.merging(["kind": "add-circle", "slug": slug]) { _, own in own }
            case let .remove(slug): ["kind": "remove", "slug": slug]
            case let .hide(latitude, longitude): ["kind": "hide", "latitude": latitude, "longitude": longitude]
            case let .unhide(key): ["kind": "unhide", "key": key]
            }
        }
    }

    public struct PlaceFields: Sendable, Equatable {
        public struct Change<Value: Sendable & Equatable>: Sendable, Equatable {
            public var was: Value
            public var to: Value

            public init(was: Value, to: Value) {
                self.was = was
                self.to = to
            }
        }

        public var name: Change<String>?
        public var circle: Change<Place.Circle>?
        public var also: Change<[Place.Circle]>?
        public var home: Change<Bool?>?

        public init(name: Change<String>? = nil, circle: Change<Place.Circle>? = nil, also: Change<[Place.Circle]>? = nil,
                    home: Change<Bool?>? = nil) {
            self.name = name
            self.circle = circle
            self.also = also
            self.home = home
        }

        public var isEmpty: Bool { name == nil && circle == nil && also == nil && home == nil }

        var members: [String: Any] {
            var members: [String: Any] = [:]
            var was: [String: Any] = [:]
            if let circle {
                members.merge(circle.to.members) { _, own in own }
                was.merge(circle.was.members) { _, own in own }
            }
            if let name {
                members["name"] = name.to
                was["name"] = name.was
            }
            if let also {
                members["also"] = also.to.map(\.members)
                was["also"] = also.was.map(\.members)
            }
            if let home {
                members["home"] = home.to ?? NSNull()
                was["home"] = home.was ?? NSNull()
            }
            if !was.isEmpty { members["was"] = was }
            return members
        }
    }

    public struct Confirm: Sendable, Equatable {
        public var id: String
        public var accept: [String] = []
        public var decline: [String] = []
        public var name: String??
        public var fullName: String??
        public var relationship: String??
        public var entity: String?
        public var hidden: Bool?
        public var add: [String] = []
        public var unlink: [String] = []
        public var details: DetailsChange?
        public var addNames: [String] = []
        public var removeNames: [String] = []
        public var split: [String] = []

        public init(id: String) {
            self.id = id
        }

        public static func hide(_ id: String) -> Confirm {
            var confirm = Confirm(id: id)
            confirm.hidden = true
            return confirm
        }

        var members: [String: Any] {
            var members: [String: Any] = ["id": id]
            if !accept.isEmpty { members["accept"] = accept }
            if !decline.isEmpty { members["decline"] = decline }
            if let name { members["name"] = name ?? NSNull() }
            if let fullName { members["full_name"] = fullName ?? NSNull() }
            if let relationship { members["relationship"] = relationship ?? NSNull() }
            if let entity { members["entity"] = entity }
            if let hidden { members["hidden"] = hidden }
            if !add.isEmpty { members["add"] = add }
            if !unlink.isEmpty { members["unlink"] = unlink }
            if let details, !details.members.isEmpty { members["details"] = details.members }
            if !addNames.isEmpty { members["add_names"] = addNames }
            if !removeNames.isEmpty { members["remove_names"] = removeNames }
            if !split.isEmpty { members["split"] = split }
            return members
        }
    }

    public struct DetailsChange: Sendable, Equatable {
        public var work: String??
        public var birthday: Person.Details.Birthday??
        public var profiles: [Person.Details.Profile]?

        public init(work: String?? = nil, birthday: Person.Details.Birthday?? = nil, profiles: [Person.Details.Profile]? = nil) {
            self.work = work
            self.birthday = birthday
            self.profiles = profiles
        }

        var members: [String: Any] {
            var members: [String: Any] = [:]
            if let work { members["work"] = work ?? NSNull() }
            if let birthday {
                members["birthday"] = birthday.map { ["month": $0.month, "day": $0.day, "year": $0.year ?? NSNull()] as [String: Any] } ?? NSNull()
            }
            if let profiles { members["profiles"] = profiles.map { ["network": $0.network, "value": $0.value] } }
            return members
        }
    }

    public struct OwnerAnswer: Decodable, Sendable, Equatable {
        public let act: String?
        public let id: String?
        public let position: String

        public init(act: String?, id: String?, position: String) {
            self.act = act
            self.id = id
            self.position = position
        }
    }

    public struct Position: Comparable, Hashable, Sendable, CustomStringConvertible {
        public let seq: Int64
        public let atMs: Int64

        public init?(_ text: String?) {
            let parts = text?.split(separator: ":", omittingEmptySubsequences: false) ?? []
            guard parts.count == 2, let seq = Int64(parts[0]), let atMs = Int64(parts[1]) else { return nil }
            self.seq = seq
            self.atMs = atMs
        }

        public static func < (left: Position, right: Position) -> Bool {
            (left.seq, left.atMs) < (right.seq, right.atMs)
        }

        public var description: String { "\(seq):\(atMs)" }
    }

    public struct Positioned<Value: Sendable>: Sendable {
        public let value: Value
        public let position: Position?

        public init(value: Value, position: Position?) {
            self.value = value
            self.position = position
        }
    }

    public struct Found: Decodable, Sendable, Equatable {
        public let people: [Person]
        public let profiles: [Person.Details.Profile]
    }

    public func act(_ action: OwnerAction) async throws -> OwnerAnswer {
        let body = try action.body()
        let response = try await contact("POST", "/v1/owner/act", ["Content-Type": "application/json"], .json(body))
        guard response.status == 200 else { throw failure(response) }
        return try Self.decoded(OwnerAnswer.self, response)
    }

    public struct Refusal: Error, Sendable, Equatable {
        public let code: String
        public let words: String

        public init(code: String, words: String) {
            self.code = code
            self.words = words
        }
    }

    public enum Acted: Sendable, Equatable {
        case answered(OwnerAnswer)
        case refused(Refusal)
        case unanswered(ActSaid)

        public var said: ActSaid? {
            switch self {
            case .answered: nil
            case .refused(let refusal): .refused(refusal.words)
            case .unanswered(let said): said
            }
        }
    }

    public func acted(_ action: OwnerAction, now: Date) async -> Acted {
        do {
            return .answered(try await act(action))
        } catch LinkFailure.refused(let status, let code, let message) where status != 401 && status != 426 {
            return .refused(Refusal(code: code, words: message))
        } catch LinkFailure.noAnswer(sent: true) {
            return .unanswered(.unknown(ReachWords.unknown))
        } catch let failure as LinkFailure {
            switch Self.state(of: failure, now: now) {
            case .inFlight?, nil: return .refused(Refusal(code: failure.code, words: failure.description))
            case let state?: return .unanswered(ReachWords.act(state) ?? .notSent)
            }
        } catch {
            return .unanswered(.unknown(ReachWords.unknown))
        }
    }

    public func findPeople(q: String) async throws -> Found {
        guard let response = try await get("/v1/people", [("q", q)]) else { throw LinkFailure.unreadable(304) }
        return try Self.decoded(Found.self, response)
    }
}
