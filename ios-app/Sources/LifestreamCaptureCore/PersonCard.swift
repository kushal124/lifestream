import Foundation
import HomeLink

public struct PersonCard: Equatable, Sendable {
    public typealias Page = HomeLink.Pages.Person
    public typealias Suggestion = HomeLink.Pages.Suggestion
    public typealias Handle = HomeLink.Pages.Person.Handle
    public typealias Joined = HomeLink.Pages.Person.Edit.Joined
    public typealias Row = HomeLink.Pages.Row
    public typealias Details = HomeLink.Person.Details
    public typealias Birthday = HomeLink.Person.Details.Birthday
    public typealias Profile = HomeLink.Person.Details.Profile

    public static let namesAtMost = 12
    static let nameAtMost = 60

    public struct Fields: Equatable, Sendable {
        public var name: String
        public var full: String
        public var relationship: String
        public var work: String

        public init(name: String = "", full: String = "", relationship: String = "", work: String = "") {
            self.name = name
            self.full = full
            self.relationship = relationship
            self.work = work
        }
    }

    public struct AlsoCalled: Equatable, Sendable, Hashable {
        public let name: String
        public let from: String

        public init(name: String, from: String) {
            self.name = name
            self.from = from
        }
    }

    public enum Added: Equatable, Sendable, Identifiable {
        case person(Row)
        case profile(Profile)

        public var id: String {
            switch self {
            case .person(let row): row.id
            case .profile(let profile): "profile:" + PersonCard.key(profile)
            }
        }
    }

    public let id: String
    public let page: Page
    public let opened: Fields
    public var fields: Fields
    public let fill: Suggestion?
    public let workFill: Suggestion?
    public let birthdayFill: Suggestion?
    public let born: Birthday?
    public var birthday: Birthday?
    public let details: Details
    public private(set) var ticks: [String: Bool]
    public var said: String?
    public private(set) var removed: Set<String> = []
    public private(set) var unlisted: Set<String> = []
    public private(set) var added: [Added] = []
    public private(set) var namesAdded: [String] = []
    public private(set) var namesRemoved: [String] = []
    public private(set) var splits: Set<String> = []

    public init(_ page: Page, id: String) {
        self.id = id
        self.page = page
        let edit = page.edit
        let suggestions = edit.suggestions
        let details = edit.details.map(Self.details) ?? .none
        fill = edit.fullName == nil ? suggestions.first { $0.kind == .fullName && $0.ticked } : nil
        workFill = details.work == nil ? suggestions.first { $0.kind == .work && $0.ticked } : nil
        birthdayFill = details.birthday == nil ? suggestions.first { $0.kind == .birthday && $0.ticked } : nil
        opened = Fields(name: edit.call ?? "", full: edit.fullName ?? fill?.value ?? "", relationship: page.head.relationship ?? "",
                        work: details.work ?? workFill?.value ?? "")
        fields = opened
        born = details.birthday ?? birthdayFill.flatMap { Self.birthday(of: $0.value) }
        birthday = born
        self.details = details
        var ticks: [String: Bool] = [:]
        for suggestion in suggestions where Self.tickable(suggestion) { ticks[suggestion.id] = suggestion.ticked }
        self.ticks = ticks
        let entity = Self.entity(page)
        said = entity == "person" ? nil : entity
    }

    public init(_ page: Page, id: String, keeping before: PersonCard) {
        self.init(page, id: id)
        if before.fields.name != before.opened.name { fields.name = before.fields.name }
        if before.fields.full != before.opened.full { fields.full = before.fields.full }
        if before.fields.relationship != before.opened.relationship { fields.relationship = before.fields.relationship }
        if before.fields.work != before.opened.work { fields.work = before.fields.work }
        if before.birthday != before.born { birthday = before.birthday }
        for (id, on) in before.ticks where ticks[id] != nil { ticks[id] = on }
        said = before.said
        added = before.added
        removed = before.removed.intersection(page.handles.map(\.id))
        unlisted = before.unlisted.intersection(details.profiles.map(Self.key))
        namesRemoved = before.namesRemoved.filter { name in page.edit.alsoCalled.contains { $0.name == name } }
        namesAdded = before.namesAdded.filter { name in !page.edit.alsoCalled.contains { Self.sameName($0.name, name) } }
        splits = before.splits.intersection(page.edit.joined.map(\.id))
    }


    public var changed: Bool { self != PersonCard(page, id: id) }

    public var shownName: String {
        Self.trimmed(fields.name) ?? Self.trimmed(fields.full) ?? page.head.name
    }

    public var named: Bool { page.head.named }

    public var hidden: Bool { page.edit.record?.hidden == true }

    public var fullFilled: Bool { fill.map { fields.full == $0.value } ?? false }
    public var workFilled: Bool { workFill.map { fields.work == $0.value } ?? false }

    public var isYou: Bool { page.me }

    public var handles: [Handle] {
        let leaving = self.leaving
        return page.handles.filter { !removed.contains($0.id) && !leaving.contains($0.id) }
    }

    public var joined: [Joined] { page.edit.joined.filter { !splits.contains($0.id) } }

    public var splitOff: [Joined] { page.edit.joined.filter { splits.contains($0.id) } }

    var leaving: Set<String> { Set(splitOff.flatMap(\.handles)) }

    public var alsoCalled: [AlsoCalled] {
        page.edit.alsoCalled.filter { !namesRemoved.contains($0.name) }.map { AlsoCalled(name: $0.name, from: $0.from) }
            + namesAdded.map { AlsoCalled(name: $0, from: "You added") }
    }

    public var namesRoom: Bool { alsoCalled.count < Self.namesAtMost }

    public var profiles: [Profile] { details.profiles.filter { !unlisted.contains(Self.key($0)) } }

    public var judged: Bool { page.head.entityBy != .you && said == Self.entity(page) }

    public var suspicions: [Suggestion] { page.edit.suggestions.filter { $0.kind == .entity } }

    public var offered: [Suggestion] { page.edit.suggestions.filter { [.handle, .same, .profile].contains($0.kind) } }

    public var guesses: [Suggestion] {
        page.edit.suggestions.filter { Self.guessed($0) && (birthday == nil || ticked($0)) }
    }

    public func ticked(_ suggestion: Suggestion) -> Bool { ticks[suggestion.id] == true }


    public mutating func toggle(_ suggestion: Suggestion) {
        guard ticks[suggestion.id] != nil else { return }
        let on = !(ticks[suggestion.id] ?? false)
        ticks[suggestion.id] = on
        if Self.guessed(suggestion) { birthday = on ? Self.birthday(of: suggestion.value) : nil }
    }

    public mutating func remove(_ handle: Handle) {
        guard !handle.own else { return }
        removed.insert(handle.id)
    }

    public mutating func remove(_ profile: Profile) {
        unlisted.insert(Self.key(profile))
    }

    public mutating func add(_ find: Added) {
        guard !added.contains(find) else { return }
        added.append(find)
    }

    public mutating func drop(_ find: Added) {
        added.removeAll { $0 == find }
    }

    @discardableResult
    public mutating func addName(_ typed: String) -> Bool {
        guard let name = Self.calledName(typed) else { return false }
        if alsoCalled.contains(where: { Self.sameName($0.name, name) }) { return true }
        if let back = namesRemoved.firstIndex(where: { Self.sameName($0, name) }) {
            namesRemoved.remove(at: back)
            return true
        }
        guard namesRoom else { return false }
        namesAdded.append(name)
        return true
    }

    public mutating func removeName(_ name: AlsoCalled) {
        if page.edit.alsoCalled.contains(where: { $0.name == name.name && $0.from == name.from }) {
            if !namesRemoved.contains(name.name) { namesRemoved.append(name.name) }
        } else {
            namesAdded.removeAll { $0 == name.name }
        }
    }

    public mutating func split(_ joined: Joined) {
        guard page.edit.joined.contains(joined) else { return }
        splits.insert(joined.id)
    }


    public var detailsNow: Details {
        var profiles: [Profile] = []
        func put(_ profile: Profile?) {
            if let profile, !profiles.contains(profile) { profiles.append(profile) }
        }
        for profile in self.profiles { put(profile) }
        for suggestion in offered where suggestion.kind == .profile && ticked(suggestion) { put(Self.profile(of: suggestion.value)) }
        for case .profile(let profile) in added { put(profile) }
        return Details(work: Self.trimmed(Self.oneSpaced(fields.work)), birthday: birthday, profiles: profiles)
    }

    public func answer() -> HomeLink.Confirm {
        var confirm = HomeLink.Confirm(id: id)
        for suggestion in page.edit.suggestions {
            if suggestion.kind == .fullName {
                if suggestion == fill, fields.full.trimmingCharacters(in: .whitespaces) == suggestion.value { confirm.accept.append(suggestion.id) }
            } else if suggestion == workFill {
                let typed = fields.work.trimmingCharacters(in: .whitespaces)
                if typed == suggestion.value { confirm.accept.append(suggestion.id) } else if typed.isEmpty { confirm.decline.append(suggestion.id) }
            } else if suggestion == birthdayFill {
                if birthday == Self.birthday(of: suggestion.value) { confirm.accept.append(suggestion.id) }
                else if birthday == nil { confirm.decline.append(suggestion.id) }
            } else if Self.guessed(suggestion) {
                if ticked(suggestion), birthday == Self.birthday(of: suggestion.value) { confirm.accept.append(suggestion.id) }
            } else if suggestion.kind != .work, suggestion.kind != .birthday {
                if ticked(suggestion) { confirm.accept.append(suggestion.id) } else { confirm.decline.append(suggestion.id) }
            }
        }
        if fields.name.trimmingCharacters(in: .whitespaces) != opened.name || page.edit.record?.show == .fullName {
            confirm.name = .some(Self.trimmed(fields.name))
        }
        if fields.full.trimmingCharacters(in: .whitespaces) != opened.full { confirm.fullName = .some(Self.trimmed(fields.full)) }
        if fields.relationship.trimmingCharacters(in: .whitespaces) != opened.relationship {
            confirm.relationship = .some(Self.trimmed(fields.relationship))
        }
        let suspected = suspicions.contains { ticked($0) }
        if !suspected, (said ?? "person") != Self.entity(page) { confirm.entity = said ?? "person" }
        let now = detailsNow
        var change = HomeLink.DetailsChange()
        if now.work != details.work { change.work = .some(now.work) }
        if now.birthday != details.birthday { change.birthday = .some(now.birthday) }
        if now.profiles != details.profiles { change.profiles = now.profiles }
        if change != HomeLink.DetailsChange() { confirm.details = change }
        confirm.add = added.compactMap { if case .person(let other) = $0 { other.id } else { nil } }
        let leaving = self.leaving
        confirm.unlink = page.handles.map(\.id).filter { removed.contains($0) && !leaving.contains($0) }
        confirm.addNames = namesAdded
        confirm.removeNames = namesRemoved
        confirm.split = splitOff.map(\.id)
        return confirm
    }


    public static func guessed(_ suggestion: Suggestion) -> Bool {
        suggestion.kind == .birthday && !suggestion.ticked
    }

    static func tickable(_ suggestion: Suggestion) -> Bool {
        !(suggestion.kind == .fullName || suggestion.kind == .work || (suggestion.kind == .birthday && !guessed(suggestion)))
    }

    static func entity(_ page: Page) -> String {
        page.head.entity == .unknown ? "person" : page.head.entity.rawValue
    }

    static func details(_ held: HomeLink.Pages.Details) -> Details {
        Details(work: held.work, birthday: held.birthday.map { Birthday(month: $0.month, day: $0.day, year: $0.year) },
                profiles: held.profiles.map(profile))
    }

    public static func profile(_ found: HomeLink.Pages.Profile) -> Profile {
        Profile(network: found.network, value: found.value)
    }

    public static func birthday(of value: String) -> Birthday? {
        let parts = value.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 2 || parts.count == 3, parts.suffix(2).allSatisfy({ $0.count == 2 }),
              parts.count == 2 || parts[0].count == 4,
              let month = Int(parts[parts.count - 2]), let day = Int(parts[parts.count - 1]) else { return nil }
        let year = parts.count == 3 ? Int(parts[0]) : nil
        guard (1...12).contains(month), day >= 1, day <= daysIn(month, year: year) else { return nil }
        return Birthday(month: month, day: day, year: year)
    }

    public static func profile(of value: String) -> Profile? {
        guard let colon = value.firstIndex(of: ":"), colon != value.startIndex, value.index(after: colon) != value.endIndex else { return nil }
        return Profile(network: String(value[..<colon]), value: String(value[value.index(after: colon)...]))
    }

    public static func key(_ profile: Profile) -> String { profile.network + ":" + profile.value }

    static func daysIn(_ month: Int, year: Int?) -> Int {
        switch month {
        case 2:
            guard let year else { return 29 }
            return year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) ? 29 : 28
        case 4, 6, 9, 11: return 30
        default: return 31
        }
    }

    public static func calledName(_ typed: String) -> String? {
        let made = oneSpaced(typed)
        guard (1...nameAtMost).contains(made.count),
              !made.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { return nil }
        return made
    }

    static func sameName(_ a: String, _ b: String) -> Bool {
        a.compare(b, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
    }

    public static func trimmed(_ words: String) -> String? {
        let trimmed = words.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func oneSpaced(_ words: String) -> String {
        words.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}

extension HomeLink.Pages.Suggestion {
    public func reason(_ name: String) -> Int {
        Int(reasons.first { $0.reason == name }?.count ?? 0)
    }
}
