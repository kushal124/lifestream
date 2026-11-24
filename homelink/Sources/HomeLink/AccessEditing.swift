import Foundation

public struct AccessEditing: Sendable, Equatable {
    public enum Trouble: Sendable, Equatable {
        case unreachable
        case changed(String)
        case refused(String)
    }

    public struct Sent: Sendable, Equatable {
        public enum Request: Sendable, Equatable {
            case edit(HomeLink.EditRequest)
            case save(reader: String, HomeLink.Access, expect: HomeLink.Version)
        }

        public let id: UUID
        public let request: Request
    }

    public let target: HomeLink.EditTarget
    public private(set) var draft: HomeLink.AccessDraft?
    public private(set) var sending: Sent?
    public private(set) var trouble: Trouble?
    private let start: HomeLink.Access
    private let expect: HomeLink.Version?

    public init(target: HomeLink.EditTarget, access: HomeLink.Access, expect: HomeLink.Version?) {
        self.target = target
        start = access
        self.expect = expect
    }

    public init(drawn reader: HomeLink.AgentRead) {
        target = .reader(reader.id)
        start = reader.access
        expect = reader.version
        draft = HomeLink.AccessDraft(access: reader.access, expect: reader.version, view: reader.view, narrowed: nil, saved: nil)
    }

    public init(target: HomeLink.EditTarget, drawn: HomeLink.AccessDraft) {
        self.target = target
        start = drawn.access
        expect = drawn.expect
        draft = drawn
    }

    public mutating func draw() -> Sent? {
        guard sending == nil, draft == nil else { return nil }
        return send(.edit(.init(target: target, access: start, expect: expect, edit: nil)))
    }

    public mutating func tap(_ edit: HomeLink.Edit) -> Sent? {
        guard sending == nil, let draft else { return nil }
        return send(.edit(.init(target: target, access: draft.access, expect: draft.expect, edit: edit)))
    }

    public mutating func save() -> Sent? {
        guard sending == nil, case .reader(let reader) = target, let draft, let expect = draft.expect else { return nil }
        return send(.save(reader: reader, draft.access, expect: expect))
    }

    public mutating func undo() -> Sent? {
        guard sending == nil, case .reader(let reader) = target, let narrowed = draft?.narrowed else { return nil }
        return send(.save(reader: reader, narrowed.undo.access, expect: narrowed.undo.expect))
    }

    @discardableResult
    public mutating func land(_ id: UUID, _ draft: HomeLink.AccessDraft) -> Bool {
        guard sending?.id == id else { return false }
        sending = nil
        trouble = nil
        let kept = self.draft?.narrowed
        self.draft = draft
        if draft.narrowed == nil, let kept, draft.expect == kept.undo.expect { self.draft?.narrowed = kept }
        return true
    }

    public mutating func fail(_ id: UUID, _ error: Error) {
        guard sending?.id == id else { return }
        sending = nil
        switch error as? LinkFailure {
        case .refused(409, "ACCESS_CHANGED", let message): trouble = .changed(message)
        case .refused(_, _, let message), .unavailable(_, let message?, _, _): trouble = .refused(message)
        default: trouble = .unreachable
        }
    }

    private mutating func send(_ request: Sent.Request) -> Sent {
        let sent = Sent(id: UUID(), request: request)
        sending = sent
        trouble = nil
        return sent
    }
}

extension HomeLink {
    public func send(_ sent: AccessEditing.Sent) async throws -> AccessDraft {
        switch sent.request {
        case .edit(let request): try await editAccess(request)
        case .save(let reader, let access, let expect): try await setAccess(reader, access, expect: expect)
        }
    }
}
