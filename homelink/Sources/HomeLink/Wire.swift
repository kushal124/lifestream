import Foundation

extension HomeLink {

    public struct Products: Decodable, Sendable, Equatable {
        public let digest: String
        public let products: [String: Product]

        public struct Product: Decodable, Sendable, Equatable {
            public let name: String
            public let row: String
            public let vendor: String
            public let icon: String?
            public let type: String?
            public let connector: String
        }
    }


    public struct Open: Codable, Sendable, Equatable, Hashable {
        public let label: String
        public let href: String
    }


    public struct RefreshBlocked: Codable, Sendable, Equatable {
        public enum Reason: String, Codable, Sendable, Equatable, CaseIterable {
            case running, held, paused, offline, chrome, disk, vault, device
        }

        public let reason: Reason
        public let words: String
        public let untilMs: Int64?

        enum CodingKeys: String, CodingKey {
            case reason, words
            case untilMs = "until_ms"
        }
    }

    public struct RefreshAsk: Encodable, Sendable, Equatable {
        public let connector: String

        public init(connector: String) { self.connector = connector }
    }

    public enum RefreshAnswer: Decodable, Sendable, Equatable {
        case queued
        case asked
        case blocked(RefreshBlocked)

        enum CodingKeys: String, CodingKey { case state, blocked }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            switch try container.decode(String.self, forKey: .state) {
            case "queued": self = .queued
            case "asked": self = .asked
            case "blocked": self = .blocked(try container.decode(RefreshBlocked.self, forKey: .blocked))
            case let other:
                throw DecodingError.dataCorruptedError(forKey: .state, in: container, debugDescription: "no refresh state \(other)")
            }
        }
    }


    public struct SealAsk: Encodable, Sendable, Equatable {
        public let connector: String
        public let member: String
        public let value: String

        public init(connector: String, member: String, value: String) {
            self.connector = connector
            self.member = member
            self.value = value
        }
    }

    public enum SealAnswer: Decodable, Sendable, Equatable {
        case sealed
        case refused(SignInRefusal)

        enum CodingKeys: String, CodingKey { case sealed }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            if try container.decodeIfPresent(Bool.self, forKey: .sealed) == true { self = .sealed } else { self = .refused(try SignInRefusal(from: decoder)) }
        }
    }

    public struct SettingAnswer: Codable, Sendable, Equatable {
        public let landed: Landed

        public struct Landed: Codable, Sendable, Equatable {
            public let connector: String
            public let member: String
            public let value: JSON

            public init(connector: String, member: String, value: JSON) {
                self.connector = connector
                self.member = member
                self.value = value
            }
        }

        public init(landed: Landed) { self.landed = landed }
    }


    public struct SignInRefusal: Decodable, Sendable, Equatable {
        public let refused: String
        public let field: String?
    }

    public struct SignedInAs: Decodable, Sendable, Equatable {
        public let account: String
        public let source: String
    }

    public struct SignInKeyAsk: Encodable, Sendable, Equatable {
        public let connector: String
        public let route: String
        public let values: [String: String]

        public init(connector: String, route: String, values: [String: String]) {
            self.connector = connector
            self.route = route
            self.values = values
        }
    }

    public struct SignInDeviceStartAsk: Encodable, Sendable, Equatable {
        public let connector: String
        public let route: String

        public init(connector: String, route: String) {
            self.connector = connector
            self.route = route
        }
    }

    public struct DeviceCode: Decodable, Sendable, Equatable {
        public let code: String
        public let open: String
        public let intervalMs: Int
        public let expiresMs: Int64
        public let attempt: JSON

        enum CodingKeys: String, CodingKey {
            case code, open, attempt
            case intervalMs = "interval_ms"
            case expiresMs = "expires_ms"
        }
    }

    public struct SignInDevicePollAsk: Encodable, Sendable, Equatable {
        public let connector: String
        public let route: String
        public let attempt: JSON
        public let intervalMs: Int

        public init(connector: String, route: String, attempt: JSON, intervalMs: Int) {
            self.connector = connector
            self.route = route
            self.attempt = attempt
            self.intervalMs = intervalMs
        }

        enum CodingKeys: String, CodingKey {
            case connector, route, attempt
            case intervalMs = "interval_ms"
        }
    }

    public struct ClientTyped: Encodable, Sendable, Equatable {
        public let clientId: String
        public let clientSecret: String

        public init(clientId: String, clientSecret: String) {
            self.clientId = clientId
            self.clientSecret = clientSecret
        }

        enum CodingKeys: String, CodingKey {
            case clientId = "client_id"
            case clientSecret = "client_secret"
        }
    }

    public struct SignInClientStartAsk: Encodable, Sendable, Equatable {
        public let connector: String
        public let route: String
        public let client: ClientTyped?
        public let port: Int?

        public init(connector: String, route: String, client: ClientTyped? = nil, port: Int? = nil) {
            self.connector = connector
            self.route = route
            self.client = client
            self.port = port
        }
    }

    public struct ClientStarted: Decodable, Sendable, Equatable {
        public let open: String
        public let attempt: JSON
        public let expiresMs: Int64
        public let listening: Bool

        enum CodingKeys: String, CodingKey {
            case open, attempt, listening
            case expiresMs = "expires_ms"
        }
    }

    public struct SignInClientFinishAsk: Encodable, Sendable, Equatable {
        public let connector: String
        public let route: String
        public let attempt: JSON
        public let address: String?

        public init(connector: String, route: String, attempt: JSON, address: String? = nil) {
            self.connector = connector
            self.route = route
            self.attempt = attempt
            self.address = address
        }
    }

    public enum SignInAnswer: Decodable, Sendable, Equatable {
        case refused(SignInRefusal)
        case code(DeviceCode)
        case started(ClientStarted)
        case pending(intervalMs: Int?)
        case denied
        case expired
        case signedIn(SignedInAs)

        enum CodingKeys: String, CodingKey {
            case refused, code, open, state
            case intervalMs = "interval_ms"
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            if container.contains(.refused) { self = .refused(try SignInRefusal(from: decoder)); return }
            if container.contains(.code) { self = .code(try DeviceCode(from: decoder)); return }
            if container.contains(.open) { self = .started(try ClientStarted(from: decoder)); return }
            switch try container.decodeIfPresent(String.self, forKey: .state) {
            case "pending": self = .pending(intervalMs: try container.decodeIfPresent(Int.self, forKey: .intervalMs))
            case "denied": self = .denied
            case "expired": self = .expired
            case nil, "signed_in": self = .signedIn(try SignedInAs(from: decoder))
            case let other?:
                throw DecodingError.dataCorruptedError(forKey: .state, in: container, debugDescription: "no sign-in state \(other)")
            }
        }
    }


    public enum StoreState: String, Codable, Sendable, Equatable, Hashable, CaseIterable {
        case asked, allowed, refused, unsafe
    }

    public struct StoresStated: Codable, Sendable, Equatable {
        public let digest: String?
        public let states: [String: StoreState]

        public init(digest: String?, states: [String: StoreState]) {
            self.digest = digest
            self.states = states
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(digest, forKey: .digest)
            try container.encode(states, forKey: .states)
        }

        enum CodingKeys: String, CodingKey { case digest, states }
    }

    public enum MacGrant: String, Codable, Sendable, Equatable, Hashable, CaseIterable {
        case screenRecording, accessibility, microphone, systemAudio, bluetooth, fullDiskAccess, photos
    }

    public struct DeclaredStore: Codable, Sendable, Equatable {
        public let app: String?
        public let grants: [MacGrant]
        public let product: String
        public let store: MacStore

        public init(app: String?, grants: [MacGrant], product: String, store: MacStore) {
            self.app = app
            self.grants = grants
            self.product = product
            self.store = store
        }

        enum CodingKeys: String, CodingKey, CaseIterable { case app, grants, product, store }

        public init(from decoder: Decoder) throws {
            try Strictly.only(CodingKeys.self, decoder)
            let container = try decoder.container(keyedBy: CodingKeys.self)
            app = try container.decodeIfPresent(String.self, forKey: .app)
            grants = try container.decode([MacGrant].self, forKey: .grants)
            product = try container.decode(String.self, forKey: .product)
            store = try container.decode(MacStore.self, forKey: .store)
        }
    }

    public struct MacStore: Codable, Sendable, Equatable {
        public let feeder: String
        public let name: String
        public let held: OneOrMany
        public let account: Account
        public let spelled: Bool?
        public let wake: String?
        public let engine: Engine

        enum CodingKeys: String, CodingKey, CaseIterable { case feeder, name, held, account, spelled, wake, engine }

        public init(from decoder: Decoder) throws {
            try Strictly.only(CodingKeys.self, decoder)
            let container = try decoder.container(keyedBy: CodingKeys.self)
            feeder = try container.decode(String.self, forKey: .feeder)
            name = try container.decode(String.self, forKey: .name)
            held = try container.decode(OneOrMany.self, forKey: .held)
            account = try container.decode(Account.self, forKey: .account)
            spelled = try container.decodeIfPresent(Bool.self, forKey: .spelled)
            wake = try container.decodeIfPresent(String.self, forKey: .wake)
            engine = try container.decode(Engine.self, forKey: .engine)
        }

        public enum OneOrMany: Codable, Sendable, Equatable {
            case one(String)
            case many([String])

            public init(from decoder: Decoder) throws {
                let container = try decoder.singleValueContainer()
                if let one = try? container.decode(String.self) { self = .one(one) } else { self = .many(try container.decode([String].self)) }
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.singleValueContainer()
                switch self {
                case .one(let one): try container.encode(one)
                case .many(let many): try container.encode(many)
                }
            }
        }

        public struct ValueRule: Codable, Sendable, Equatable {
            public let holds: String?
            public let before: String?
            public let digits: Bool?
        }

        public struct Test: Codable, Sendable, Equatable {
            public let at: String
            public let equals: Scalar?
            public let prefix: String?
            public let object: Bool?

            enum CodingKeys: String, CodingKey, CaseIterable { case at, equals, prefix, object }

            public init(from decoder: Decoder) throws {
                try Strictly.only(CodingKeys.self, decoder)
                let container = try decoder.container(keyedBy: CodingKeys.self)
                at = try container.decode(String.self, forKey: .at)
                equals = try container.decodeIfPresent(Scalar.self, forKey: .equals)
                prefix = try container.decodeIfPresent(String.self, forKey: .prefix)
                object = try container.decodeIfPresent(Bool.self, forKey: .object)
            }
        }

        public enum Scalar: Codable, Sendable, Equatable {
            case text(String)
            case number(Double)

            public init(from decoder: Decoder) throws {
                let container = try decoder.singleValueContainer()
                if let text = try? container.decode(String.self) { self = .text(text) } else { self = .number(try container.decode(Double.self)) }
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.singleValueContainer()
                switch self {
                case .text(let text): try container.encode(text)
                case .number(let number): try container.encode(number)
                }
            }
        }

        public enum Account: Codable, Sendable, Equatable {
            case local
            case appleID
            case plist(plist: String, key: String, rule: ValueRule)
            case json(json: String, at: String, rule: ValueRule)
            case jsonKeys(jsonKeys: String, at: String, where: [Test]?)
            case folders(folders: String, match: String, holding: String, spell: String)

            enum CodingKeys: String, CodingKey, CaseIterable {
                case plist, key, json, at, folders, match, holding, spell, holds, before, digits, `where`
                case jsonKeys = "json_keys"
            }

            public init(from decoder: Decoder) throws {
                if let word = try? decoder.singleValueContainer().decode(String.self) {
                    switch word {
                    case "local": self = .local
                    case "apple-id": self = .appleID
                    default: throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "no account rule \(word)"))
                    }
                    return
                }
                let container = try decoder.container(keyedBy: CodingKeys.self)
                if container.contains(.plist) {
                    try Strictly.only([CodingKeys.plist, .key, .holds, .before, .digits], decoder)
                    self = .plist(plist: try container.decode(String.self, forKey: .plist), key: try container.decode(String.self, forKey: .key),
                                  rule: try ValueRule(from: decoder))
                } else if container.contains(.json) {
                    try Strictly.only([CodingKeys.json, .at, .holds, .before, .digits], decoder)
                    self = .json(json: try container.decode(String.self, forKey: .json), at: try container.decode(String.self, forKey: .at),
                                 rule: try ValueRule(from: decoder))
                } else if container.contains(.jsonKeys) {
                    try Strictly.only([CodingKeys.jsonKeys, .at, .where], decoder)
                    self = .jsonKeys(jsonKeys: try container.decode(String.self, forKey: .jsonKeys), at: try container.decode(String.self, forKey: .at),
                                     where: try container.decodeIfPresent([Test].self, forKey: .where))
                } else {
                    try Strictly.only([CodingKeys.folders, .match, .holding, .spell], decoder)
                    self = .folders(folders: try container.decode(String.self, forKey: .folders), match: try container.decode(String.self, forKey: .match),
                                    holding: try container.decode(String.self, forKey: .holding), spell: try container.decode(String.self, forKey: .spell))
                }
            }

            public func encode(to encoder: Encoder) throws {
                switch self {
                case .local:
                    var container = encoder.singleValueContainer()
                    try container.encode("local")
                case .appleID:
                    var container = encoder.singleValueContainer()
                    try container.encode("apple-id")
                case .plist(let plist, let key, let rule):
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    try container.encode(plist, forKey: .plist)
                    try container.encode(key, forKey: .key)
                    try rule.encode(to: encoder)
                case .json(let json, let at, let rule):
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    try container.encode(json, forKey: .json)
                    try container.encode(at, forKey: .at)
                    try rule.encode(to: encoder)
                case .jsonKeys(let jsonKeys, let at, let tests):
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    try container.encode(jsonKeys, forKey: .jsonKeys)
                    try container.encode(at, forKey: .at)
                    try container.encodeIfPresent(tests, forKey: .where)
                case .folders(let folders, let match, let holding, let spell):
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    try container.encode(folders, forKey: .folders)
                    try container.encode(match, forKey: .match)
                    try container.encode(holding, forKey: .holding)
                    try container.encode(spell, forKey: .spell)
                }
            }
        }

        public enum Engine: Codable, Sendable, Equatable {
            case sqlite(stores: [SqliteStore])
            case file(files: [Member], names: Names?)
            case logs(roots: [Root], match: String, beside: String?, start: Start?)
            case biome(stream: String)

            enum CodingKeys: String, CodingKey, CaseIterable { case kind, stores, files, names, roots, match, beside, start, stream }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                switch try container.decode(String.self, forKey: .kind) {
                case "sqlite":
                    try Strictly.only([CodingKeys.kind, .stores], decoder)
                    self = .sqlite(stores: try container.decode([SqliteStore].self, forKey: .stores))
                case "file":
                    try Strictly.only([CodingKeys.kind, .files, .names], decoder)
                    self = .file(files: try container.decode([Member].self, forKey: .files), names: try container.decodeIfPresent(Names.self, forKey: .names))
                case "logs":
                    try Strictly.only([CodingKeys.kind, .roots, .match, .beside, .start], decoder)
                    self = .logs(roots: try container.decode([Root].self, forKey: .roots), match: try container.decode(String.self, forKey: .match),
                                 beside: try container.decodeIfPresent(String.self, forKey: .beside), start: try container.decodeIfPresent(Start.self, forKey: .start))
                case "biome":
                    try Strictly.only([CodingKeys.kind, .stream], decoder)
                    self = .biome(stream: try container.decode(String.self, forKey: .stream))
                case let other:
                    throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "no engine \(other)")
                }
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                switch self {
                case .sqlite(let stores):
                    try container.encode("sqlite", forKey: .kind)
                    try container.encode(stores, forKey: .stores)
                case .file(let files, let names):
                    try container.encode("file", forKey: .kind)
                    try container.encode(files, forKey: .files)
                    try container.encodeIfPresent(names, forKey: .names)
                case .logs(let roots, let match, let beside, let start):
                    try container.encode("logs", forKey: .kind)
                    try container.encode(roots, forKey: .roots)
                    try container.encode(match, forKey: .match)
                    try container.encodeIfPresent(beside, forKey: .beside)
                    try container.encodeIfPresent(start, forKey: .start)
                case .biome(let stream):
                    try container.encode("biome", forKey: .kind)
                    try container.encode(stream, forKey: .stream)
                }
            }

            public struct Member: Codable, Sendable, Equatable {
                public let path: String
                public let member: String

                enum CodingKeys: String, CodingKey, CaseIterable { case path, member }

                public init(from decoder: Decoder) throws {
                    try Strictly.only(CodingKeys.self, decoder)
                    let container = try decoder.container(keyedBy: CodingKeys.self)
                    path = try container.decode(String.self, forKey: .path)
                    member = try container.decode(String.self, forKey: .member)
                }
            }

            public struct Names: Codable, Sendable, Equatable {
                public let from: String
                public let at: String
                public let `where`: [Test]?
                public let root: String
                public let index: String

                enum CodingKeys: String, CodingKey, CaseIterable { case from, at, `where`, root, index }

                public init(from decoder: Decoder) throws {
                    try Strictly.only(CodingKeys.self, decoder)
                    let container = try decoder.container(keyedBy: CodingKeys.self)
                    from = try container.decode(String.self, forKey: .from)
                    at = try container.decode(String.self, forKey: .at)
                    self.where = try container.decodeIfPresent([Test].self, forKey: .where)
                    root = try container.decode(String.self, forKey: .root)
                    index = try container.decode(String.self, forKey: .index)
                }
            }

            public struct Root: Codable, Sendable, Equatable {
                public let path: String
                public let depth: Int?
                public let days: Bool?

                enum CodingKeys: String, CodingKey, CaseIterable { case path, depth, days }

                public init(from decoder: Decoder) throws {
                    try Strictly.only(CodingKeys.self, decoder)
                    let container = try decoder.container(keyedBy: CodingKeys.self)
                    path = try container.decode(String.self, forKey: .path)
                    depth = try container.decodeIfPresent(Int.self, forKey: .depth)
                    days = try container.decodeIfPresent(Bool.self, forKey: .days)
                }
            }

            public struct Start: Codable, Sendable, Equatable {
                public let line: Line
                public let session: [Test]?
                public let program: [Test]

                enum CodingKeys: String, CodingKey, CaseIterable { case line, session, program }

                public init(from decoder: Decoder) throws {
                    try Strictly.only(CodingKeys.self, decoder)
                    let container = try decoder.container(keyedBy: CodingKeys.self)
                    line = try container.decode(Line.self, forKey: .line)
                    session = try container.decodeIfPresent([Test].self, forKey: .session)
                    program = try container.decode([Test].self, forKey: .program)
                }

                public enum Line: Codable, Sendable, Equatable {
                    case first
                    case stating(String)

                    enum CodingKeys: String, CodingKey, CaseIterable { case stating }

                    public init(from decoder: Decoder) throws {
                        if let word = try? decoder.singleValueContainer().decode(String.self) {
                            guard word == "first" else {
                                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "no start line \(word)"))
                            }
                            self = .first
                            return
                        }
                        try Strictly.only(CodingKeys.self, decoder)
                        self = .stating(try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .stating))
                    }

                    public func encode(to encoder: Encoder) throws {
                        switch self {
                        case .first:
                            var container = encoder.singleValueContainer()
                            try container.encode("first")
                        case .stating(let stating):
                            var container = encoder.container(keyedBy: CodingKeys.self)
                            try container.encode(stating, forKey: .stating)
                        }
                    }
                }
            }
        }

        public struct SqliteStore: Codable, Sendable, Equatable {
            public let path: String
            public let match: String?
            public let member: String
            public let identity: Identity
            public let optional: Bool?
            public let fileRoot: String?
            public let attachments: Attachments?
            public let tables: [Table]

            public enum Identity: String, Codable, Sendable, Equatable {
                case file
                case coreData = "core-data"
                case calendar
            }

            enum CodingKeys: String, CodingKey, CaseIterable {
                case path, match, member, identity, optional, attachments, tables
                case fileRoot = "file_root"
            }

            public init(from decoder: Decoder) throws {
                try Strictly.only(CodingKeys.self, decoder)
                let container = try decoder.container(keyedBy: CodingKeys.self)
                path = try container.decode(String.self, forKey: .path)
                match = try container.decodeIfPresent(String.self, forKey: .match)
                member = try container.decode(String.self, forKey: .member)
                identity = try container.decode(Identity.self, forKey: .identity)
                optional = try container.decodeIfPresent(Bool.self, forKey: .optional)
                fileRoot = try container.decodeIfPresent(String.self, forKey: .fileRoot)
                attachments = try container.decodeIfPresent(Attachments.self, forKey: .attachments)
                tables = try container.decode([Table].self, forKey: .tables)
            }

            public enum Selects: Codable, Sendable, Equatable {
                case one(String)
                case first([When])

                public init(from decoder: Decoder) throws {
                    let container = try decoder.singleValueContainer()
                    if let one = try? container.decode(String.self) { self = .one(one) } else { self = .first(try container.decode([When].self)) }
                }

                public func encode(to encoder: Encoder) throws {
                    var container = encoder.singleValueContainer()
                    switch self {
                    case .one(let one): try container.encode(one)
                    case .first(let first): try container.encode(first)
                    }
                }

                public struct When: Codable, Sendable, Equatable {
                    public let sql: String
                    public let when: String?

                    enum CodingKeys: String, CodingKey, CaseIterable { case sql, when }

                    public init(from decoder: Decoder) throws {
                        try Strictly.only(CodingKeys.self, decoder)
                        let container = try decoder.container(keyedBy: CodingKeys.self)
                        sql = try container.decode(String.self, forKey: .sql)
                        when = try container.decodeIfPresent(String.self, forKey: .when)
                    }
                }
            }

            public struct Attachments: Codable, Sendable, Equatable {
                public let member: String
                public let select: Selects

                enum CodingKeys: String, CodingKey, CaseIterable { case member, select }

                public init(from decoder: Decoder) throws {
                    try Strictly.only(CodingKeys.self, decoder)
                    let container = try decoder.container(keyedBy: CodingKeys.self)
                    member = try container.decode(String.self, forKey: .member)
                    select = try container.decode(Selects.self, forKey: .select)
                }
            }

            public struct Table: Codable, Sendable, Equatable {
                public let name: String
                public let key: String?
                public let role: Role
                public let keep: Selects?
                public let touchedBy: [[String]]?
                public let chosen: String?
                public let whenDeclared: Bool?
                public let files: [String]?

                enum CodingKeys: String, CodingKey, CaseIterable {
                    case name, key, role, keep, chosen, files
                    case touchedBy = "touched_by"
                    case whenDeclared = "when_declared"
                }

                public init(from decoder: Decoder) throws {
                    try Strictly.only(CodingKeys.self, decoder)
                    let container = try decoder.container(keyedBy: CodingKeys.self)
                    name = try container.decode(String.self, forKey: .name)
                    key = try container.decodeIfPresent(String.self, forKey: .key)
                    role = try container.decode(Role.self, forKey: .role)
                    keep = try container.decodeIfPresent(Selects.self, forKey: .keep)
                    touchedBy = try container.decodeIfPresent([[String]].self, forKey: .touchedBy)
                    if let touched = touchedBy, touched.contains(where: { $0.count != 2 && $0.count != 3 }) {
                        throw DecodingError.dataCorruptedError(forKey: .touchedBy, in: container,
                                                               debugDescription: "each touched_by is a table, its SQL and maybe its when")
                    }
                    chosen = try container.decodeIfPresent(String.self, forKey: .chosen)
                    whenDeclared = try container.decodeIfPresent(Bool.self, forKey: .whenDeclared)
                    files = try container.decodeIfPresent([String].self, forKey: .files)
                }

                public enum Role: Codable, Sendable, Equatable {
                    case changes, follows, whole
                    case main(time: String, rows: String)

                    enum CodingKeys: String, CodingKey, CaseIterable { case main }
                    enum MainKeys: String, CodingKey, CaseIterable { case time, rows }

                    public init(from decoder: Decoder) throws {
                        if let word = try? decoder.singleValueContainer().decode(String.self) {
                            switch word {
                            case "changes": self = .changes
                            case "follows": self = .follows
                            case "whole": self = .whole
                            default: throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "no role \(word)"))
                            }
                            return
                        }
                        try Strictly.only(CodingKeys.self, decoder)
                        let main = try decoder.container(keyedBy: CodingKeys.self).superDecoder(forKey: .main)
                        try Strictly.only(MainKeys.self, main)
                        let container = try main.container(keyedBy: MainKeys.self)
                        self = .main(time: try container.decode(String.self, forKey: .time), rows: try container.decode(String.self, forKey: .rows))
                    }

                    public func encode(to encoder: Encoder) throws {
                        switch self {
                        case .changes, .follows, .whole:
                            var container = encoder.singleValueContainer()
                            try container.encode(self == .changes ? "changes" : self == .follows ? "follows" : "whole")
                        case .main(let time, let rows):
                            var container = encoder.container(keyedBy: CodingKeys.self)
                            var main = container.nestedContainer(keyedBy: MainKeys.self, forKey: .main)
                            try main.encode(time, forKey: .time)
                            try main.encode(rows, forKey: .rows)
                        }
                    }
                }
            }
        }
    }
}

enum Strictly {
    private struct AnyKey: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    static func only<Key: CodingKey & CaseIterable>(_: Key.Type, _ decoder: Decoder) throws {
        try only(Array(Key.allCases), decoder)
    }

    static func only<Key: CodingKey>(_ keys: [Key], _ decoder: Decoder) throws {
        let known = Set(keys.map(\.stringValue))
        let container = try decoder.container(keyedBy: AnyKey.self)
        if let unknown = container.allKeys.map(\.stringValue).sorted().first(where: { !known.contains($0) }) {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "no member \(unknown) in this shape"))
        }
    }
}
