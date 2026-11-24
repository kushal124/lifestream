import Foundation
import DeviceFiles
import XCTest
@testable import Shipping

final class MacAccountsTests: XCTestCase {
    private static let unit = "macbook-pro-0001"
    private static let apple = ["apple-calendar", "apple-calls", "apple-notes", "apple-reminders", "imessage",
                                "now-playing", "safari", "screen-time"]
    private var home: URL!

    override func setUpWithError() throws {
        home = try DomainFixtures.scratch("mac-accounts-tests")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: home.path)
        try? FileManager.default.removeItem(at: home)
    }

    private var paths: ShippingDomains.Paths { paths(photosAllowed: false) }
    private var applications: URL { home.appendingPathComponent("Applications", isDirectory: true) }

    private func stores(_ paths: ShippingDomains.Paths? = nil) throws -> DeclaredStores {
        let mac = (paths ?? self.paths).stores(applications: [applications], lifestream: { [] }, wake: { _ in })
        let state = home.appendingPathComponent("stores-state", isDirectory: true)
        let stores = DeclaredStores(file: state.appendingPathComponent("stores.json"),
                                    consent: StoreConsent(file: state.appendingPathComponent("allowed.json"), known: try StoreFixtures.known(), files: DeviceFiles(.plain)),
                                    mac: mac)
        try stores.take(StoreFixtures.all())
        return stores
    }

    private func held() throws -> Set<String> {
        let stores = try stores()
        return Set(stores.declarations.keys.filter(stores.held))
    }

    private func paths(photosAllowed: Bool) -> ShippingDomains.Paths {
        ShippingDomains.conventional(home: home, spool: home.appendingPathComponent("spool", isDirectory: true),
                                     fullDiskAccessWitness: witness, photosAllowed: { photosAllowed }, importRoom: .roomy(home), files: DeviceFiles(.plain))
    }

    private var witness: URL { home.appendingPathComponent("TCC.db") }
    private var library: URL { home.appendingPathComponent("Library", isDirectory: true) }
    private var accountList: URL { library.appendingPathComponent("Preferences/MobileMeAccounts.plist") }
    private var whatsAppPreferences: URL {
        library.appendingPathComponent(
            "Group Containers/group.net.whatsapp.WhatsApp.shared/Library/Preferences/group.net.whatsapp.WhatsApp.shared.plist")
    }
    private var wisprConfig: URL { library.appendingPathComponent("Application Support/Wispr Flow/config.json") }

    private func holdEveryProduct() throws {
        try write(Data(), to: witness)
        for file in ["Messages/chat.db", "Application Support/CallHistoryDB/CallHistory.storedata",
                     "Group Containers/group.com.apple.notes/NoteStore.sqlite",
                     "Group Containers/group.com.apple.calendar/Calendar.sqlitedb", "Safari/History.db",
                     "Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite",
                     "Application Support/Wispr Flow/flow.sqlite"] {
            try write(Data(), to: library.appendingPathComponent(file))
        }
        for folder in ["Group Containers/group.com.apple.reminders/Container_v1/Stores",
                       "Biome/streams/restricted/App.InFocus", "Biome/streams/restricted/Media.NowPlaying"] {
            try FileManager.default.createDirectory(at: library.appendingPathComponent(folder), withIntermediateDirectories: true)
        }
        try FileManager.default.createDirectory(at: home.appendingPathComponent("Pictures/Photos Library.photoslibrary"),
                                                withIntermediateDirectories: true)
    }

    private func write(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url)
    }

    private func plist(_ object: [String: Any], to url: URL) throws {
        try write(PropertyListSerialization.data(fromPropertyList: object, format: .binary, options: 0), to: url)
    }

    private func signIn(apple accountID: Any?, whatsApp jid: String?, wispr email: String?) throws {
        if let accountID {
            try plist(["Accounts": [["AccountID": accountID, "AccountDescription": "iCloud", "Services": [["Name": "MESSAGES"]]]]],
                      to: accountList)
        }
        if let jid { try plist(["OwnJabberID": jid, "OtherKey": 1], to: whatsAppPreferences) }
        if let email {
            try write(JSONSerialization.data(withJSONObject: ["prefs": ["user": ["email": email, "firstName": "A"]]]), to: wisprConfig)
        }
    }

    private func offers(_ paths: ShippingDomains.Paths? = nil) throws -> [String] {
        let paths = paths ?? self.paths
        let offers = ShippingDomains.offers(unit: Self.unit, paths: paths, stores: try stores(paths))
        for offer in offers {
            let parts = offer.split(separator: ":", omittingEmptySubsequences: false)
            XCTAssertEqual(parts.count, 3, offer)
            XCTAssertEqual(parts.last.map(String.init), Self.unit, offer)
            XCTAssertFalse(parts.contains(where: \.isEmpty), offer)
            XCTAssertFalse(offer.contains(where: { "/\\\0".contains($0) || $0.isWhitespace }), offer)
        }
        return offers
    }

    private func appleOffers(_ account: String) -> [String] {
        Self.apple.map { "\($0):\(account):\(Self.unit)" }
    }

    func testEachAccountIsSpelledAsTheHomeSpellsIt() throws {
        try holdEveryProduct()
        try signIn(apple: "  Person-A@Example.COM ", whatsApp: "15550000001@s.whatsapp.net", wispr: "Person-B@Example.com")
        XCTAssertEqual(try offers(), (appleOffers("person-a@example.com")
            + ["whatsapp:15550000001:\(Self.unit)", "wispr-flow:person-b@example.com:\(Self.unit)"]).sorted())
        XCTAssertEqual(MacAccounts.spelled(" +1 (555) 000-0001 "), "+15550000001")
        XCTAssertEqual(MacAccounts.spelled("15550000001"), "15550000001")
        XCTAssertNil(MacAccounts.spelled("  "))
        XCTAssertNil(MacAccounts.spelled("+"))
        XCTAssertNil(MacAccounts.spelled("person a@example.com"))
        XCTAssertNil(MacAccounts.spelled("a:b@example.com"))
        XCTAssertNil(MacAccounts.spelled("a/b@example.com"))
    }

    func testTheAppleSourcesAreFiledUnderTheAppleIDOrLocal() throws {
        try holdEveryProduct()
        try signIn(apple: "person-a@example.com", whatsApp: nil, wispr: nil)
        XCTAssertEqual(try offers(), appleOffers("person-a@example.com"))
        try plist(["Accounts": [["AccountID": "person-a@example.com"], ["AccountID": "person-b@example.com"]]], to: accountList)
        XCTAssertEqual(try offers(), appleOffers("person-a@example.com"))
        try plist(["Accounts": [[String: Any]]()], to: accountList)
        XCTAssertEqual(try offers(), appleOffers("local"))
        try FileManager.default.removeItem(at: accountList)
        XCTAssertEqual(try offers(), appleOffers("local"))
    }

    func testAnAccountListThatDoesNotReadOffersNoAppleSource() throws {
        try holdEveryProduct()
        try signIn(apple: "a:b@example.com", whatsApp: "15550000001@s.whatsapp.net", wispr: nil)
        XCTAssertEqual(try offers(), ["whatsapp:15550000001:\(Self.unit)"], "an account that does not spell")
        try signIn(apple: 42, whatsApp: nil, wispr: nil)
        XCTAssertEqual(try offers(), ["whatsapp:15550000001:\(Self.unit)"], "an account that is not a string")
        try write(Data("not a property list".utf8), to: accountList)
        XCTAssertEqual(try offers(), ["whatsapp:15550000001:\(Self.unit)"], "a list that does not parse")
        try signIn(apple: "person-a@example.com", whatsApp: nil, wispr: nil)
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: accountList.path)
        XCTAssertEqual(try offers(), ["whatsapp:15550000001:\(Self.unit)"], "a list this process may not read")
    }

    func testAProductIsOfferedOnlyWhileTheMacHoldsItsData() throws {
        try signIn(apple: "person-a@example.com", whatsApp: "15550000001@s.whatsapp.net", wispr: "person-b@example.com")
        XCTAssertEqual(try offers(), [], "a Mac that holds no product's data")
        try holdEveryProduct()
        XCTAssertEqual(try offers().count, Self.apple.count + 2)
        let held: [(String, String)] = [
            ("imessage", "Messages/chat.db"),
            ("apple-calls", "Application Support/CallHistoryDB/CallHistory.storedata"),
            ("apple-notes", "Group Containers/group.com.apple.notes/NoteStore.sqlite"),
            ("apple-calendar", "Group Containers/group.com.apple.calendar/Calendar.sqlitedb"),
            ("apple-reminders", "Group Containers/group.com.apple.reminders/Container_v1/Stores"),
            ("safari", "Safari/History.db"),
            ("screen-time", "Biome/streams/restricted/App.InFocus"),
            ("now-playing", "Biome/streams/restricted/Media.NowPlaying"),
            ("whatsapp", "Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite"),
            ("wispr-flow", "Application Support/Wispr Flow/flow.sqlite"),
        ]
        for (product, path) in held {
            try FileManager.default.removeItem(at: library.appendingPathComponent(path))
            XCTAssertFalse(try offers().contains { $0.hasPrefix("\(product):") }, product)
        }
        XCTAssertEqual(try offers(), [])
    }

    func testPhotosIsOfferedUnderTheAppleIDOnlyOnceAllowed() throws {
        try signIn(apple: "person-a@example.com", whatsApp: nil, wispr: nil)
        let photos = "apple-photos:person-a@example.com:\(Self.unit)"
        XCTAssertEqual(try offers(paths(photosAllowed: true)), [photos])
        try FileManager.default.createDirectory(at: home.appendingPathComponent("Pictures/Photos Library.photoslibrary"),
                                                withIntermediateDirectories: true)
        XCTAssertEqual(try offers(), [], "a library, and not allowed")
        XCTAssertEqual(ShippingDomains.build([photos], paths: paths, stores: try stores()).count, 0, "nothing seals it while not allowed")
        XCTAssertTrue(ShippingDomains.build([photos], paths: paths(photosAllowed: true), stores: try stores()).first is PhotosDomain)
    }

    func testWhatsAppAndWisprFlowWaitForTheirAccount() throws {
        try holdEveryProduct()
        try signIn(apple: nil, whatsApp: nil, wispr: nil)
        XCTAssertEqual(try offers(), appleOffers("local"), "neither app states an account")
        try plist(["OtherKey": 1], to: whatsAppPreferences)
        try write(JSONSerialization.data(withJSONObject: ["prefs": ["user": ["firstName": "A"]]]), to: wisprConfig)
        XCTAssertEqual(try offers(), appleOffers("local"))
        for jid in ["15550000001@lid", "@s.whatsapp.net", "1555000000x@s.whatsapp.net", "15550000001"] {
            try signIn(apple: nil, whatsApp: jid, wispr: nil)
            XCTAssertEqual(try offers(), appleOffers("local"), jid)
        }
        try signIn(apple: nil, whatsApp: nil, wispr: "not an email")
        XCTAssertEqual(try offers(), appleOffers("local"))
        try signIn(apple: nil, whatsApp: "15550000001@s.whatsapp.net", wispr: "person-b@example.com")
        for file in [whatsAppPreferences, wisprConfig] {
            try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: file.path)
        }
        XCTAssertEqual(try offers(), appleOffers("local"))
        for file in [whatsAppPreferences, wisprConfig] {
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        }
        XCTAssertEqual(try offers(), (appleOffers("local")
            + ["whatsapp:15550000001:\(Self.unit)", "wispr-flow:person-b@example.com:\(Self.unit)"]).sorted())
    }

    func testASourceIsSealedOnlyWhileThisMacOffersIt() throws {
        try holdEveryProduct()
        try signIn(apple: nil, whatsApp: "15550000001@s.whatsapp.net", wispr: "person-b@example.com")
        let unit = Self.unit
        let sources = ["imessage:local:\(unit)", "imessage:person-a@example.com:\(unit)", "apple-notes:local:\(unit)",
                       "whatsapp:15550000001:\(unit)", "whatsapp:15550000002:\(unit)",
                       "wispr-flow:person-b@example.com:\(unit)", "screen:local:\(unit)", "input:local:\(unit)"]
        func built() throws -> [String] { ShippingDomains.build(sources, paths: paths, stores: try stores()).map(\.sourceId).sorted() }
        let own = ["input:local:\(unit)", "screen:local:\(unit)"]
        XCTAssertEqual(try built(), (own + ["apple-notes:local:\(unit)", "imessage:local:\(unit)", "whatsapp:15550000001:\(unit)",
                                        "wispr-flow:person-b@example.com:\(unit)"]).sorted())
        try signIn(apple: "person-a@example.com", whatsApp: "15550000002@s.whatsapp.net", wispr: nil)
        try write(JSONSerialization.data(withJSONObject: ["prefs": ["user": ["firstName": "A"]]]), to: wisprConfig)
        XCTAssertEqual(try built(), (own + ["imessage:person-a@example.com:\(unit)", "whatsapp:15550000002:\(unit)"]).sorted())
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: accountList.path)
        XCTAssertEqual(try built(), (own + ["whatsapp:15550000002:\(unit)"]).sorted())
        try FileManager.default.removeItem(at: witness)
        XCTAssertEqual(try built(), own)
        XCTAssertFalse(try held().contains("whatsapp"))
    }

    func testEachProductIsHeldByTheFileItsStoreDeclares() throws {
        XCTAssertEqual(try held(), [], "a Mac that holds nothing")
        try holdEveryProduct()
        let library = self.library
        try FileManager.default.createDirectory(at: library.appendingPathComponent("Application Support/Aqua Voice"), withIntermediateDirectories: true)
        let chrome = library.appendingPathComponent("Application Support/Google/Chrome")
        for (folder, history) in [("Profile 2", true), ("Profile 3", false), ("System Profile", true), ("Guest Profile", true)] {
            try FileManager.default.createDirectory(at: chrome.appendingPathComponent(folder), withIntermediateDirectories: true)
            if history { try write(Data(), to: chrome.appendingPathComponent(folder).appendingPathComponent("History")) }
        }
        for folder in [".claude/projects", ".codex/sessions"] {
            try FileManager.default.createDirectory(at: home.appendingPathComponent(folder), withIntermediateDirectories: true)
        }
        let every: Set<String> = Set(Self.apple + ["whatsapp", "wispr-flow", "chrome", "aqua-voice", "claude-code", "codex"])
        XCTAssertEqual(try held(), every)
        XCTAssertEqual(try offers().filter { $0.hasPrefix("chrome:") }, ["chrome:profile-2:\(Self.unit)"])
        let offered = Set(try offers().map { String($0.prefix { $0 != ":" }) })
        XCTAssertTrue(offered.isSubset(of: every))
        XCTAssertTrue(offered.contains("chrome"))
        try FileManager.default.removeItem(at: chrome.appendingPathComponent("Profile 2/History"))
        XCTAssertFalse(try held().contains("chrome"))
    }

    func testAConnectorIsFoundByItsAppItsFilesOrMacOSItselfNeverByDeclaringNoApp() throws {
        let always = ["apple-photos", "audio", "input", "machine", "now-playing", "screen", "screen-time", "upload"]
        XCTAssertEqual(ShippingDomains.found(stores: try stores()), always, "macOS's own and this app's, on any Mac")
        for app in ["Messages", "WhatsApp"] {
            try FileManager.default.createDirectory(at: applications.appendingPathComponent("\(app).app"), withIntermediateDirectories: true)
        }
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".claude/projects"), withIntermediateDirectories: true)
        XCTAssertEqual(ShippingDomains.found(stores: try stores()), (always + ["claude-code", "imessage", "whatsapp"]).sorted(),
                       "an app by its bundle, whatever this Mac may read of its data; Claude Code by its sessions' folder; no Codex")
        XCTAssertEqual(Set(ShippingDomains.recorders.keys).union(try stores().declarations.keys),
                       Set(Self.apple + ["apple-photos", "whatsapp", "chrome", "wispr-flow", "aqua-voice", "claude-code", "codex",
                                         "upload", "screen", "input", "audio", "machine"]),
                       "every Mac connector, each found by its recorder or its store")
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".codex/archived_sessions"), withIntermediateDirectories: true)
        XCTAssertTrue(ShippingDomains.found(stores: try stores()).contains("codex"))
        XCTAssertTrue(try held().contains("codex"))
    }

    func testAProductIsHeldByItsDataNeverByItsApp() throws {
        let container = library.appendingPathComponent("Group Containers/group.net.whatsapp.WhatsApp.shared", isDirectory: true)
        try write(Data(), to: container.appendingPathComponent("ChatStorage.sqlite"))
        XCTAssertFalse(try held().contains("whatsapp"), "nothing reads it until the grant")
        try write(Data(), to: witness)
        try FileManager.default.removeItem(at: container.appendingPathComponent("ChatStorage.sqlite"))
        XCTAssertFalse(try held().contains("whatsapp"))
        try write(Data(), to: container.appendingPathComponent("ChatStorage.sqlite"))
        XCTAssertTrue(try held().contains("whatsapp"))
    }

    func testWhatsAppIsReadOnlyWithFullDiskAccess() throws {
        try holdEveryProduct()
        try signIn(apple: "person-a@example.com", whatsApp: "15550000001@s.whatsapp.net", wispr: nil)
        let whatsApp = "whatsapp:15550000001:\(Self.unit)"
        XCTAssertTrue(try offers().contains(whatsApp))
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: witness.path)
        XCTAssertEqual(try offers(), [], "without Full Disk Access")
        try FileManager.default.removeItem(at: witness)
        XCTAssertEqual(try offers(), [])
        try write(Data(), to: witness)
        XCTAssertTrue(try offers().contains(whatsApp))
    }
}
