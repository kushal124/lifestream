import Shipping
import SQLite3
import XCTest
@testable import Lifestream

final class DetectionTests: XCTestCase {
    private var scratch: URL!
    private var work: URL { scratch.appendingPathComponent("work", isDirectory: true) }
    private var places: Detection.Places!

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory.appendingPathComponent("detection-\(UUID().uuidString)")
        places = Detection.Places(applications: [scratch.appendingPathComponent("Applications"), scratch.appendingPathComponent("home/Applications")],
                                  support: scratch.appendingPathComponent("home/Library/Application Support"))
        for folder in places.applications + [places.support] {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        }
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: scratch)
    }

    private func app(_ name: String, id: String?, in folder: Int = 0) throws {
        let contents = places.applications[folder].appendingPathComponent("\(name).app/Contents")
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        let info: [String: Any] = id.map { ["CFBundleIdentifier": $0] } ?? ["CFBundleName": name]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: contents.appendingPathComponent("Info.plist"))
    }

    private func history(_ family: String, profile: String, urls: [String]) throws {
        let folder = places.support.appendingPathComponent(family).appendingPathComponent(profile)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(folder.appendingPathComponent("History").path, &db), SQLITE_OK)
        defer { sqlite3_close(db) }
        let rows = urls.map { "('\($0)')" }.joined(separator: ",")
        let sql = "CREATE TABLE IF NOT EXISTS urls (id INTEGER PRIMARY KEY, url LONGVARCHAR);" + (urls.isEmpty ? "" : "INSERT INTO urls (url) VALUES \(rows);")
        XCTAssertEqual(sqlite3_exec(db, sql, nil, nil, nil), SQLITE_OK)
    }

    func testOpenAIsCodePageOpensWhereThePersonUsesChatGPT() throws {
        try app("Google Chrome", id: "com.google.Chrome")
        try app("Arc", id: "company.thebrowser.Browser")
        let page = Detection.sites(of: URL(string: "https://auth.openai.com/codex/device")!)
        XCTAssertNil(Detection.browserUsing(page, scratch: work, places: places, defaultBrowser: "com.apple.Safari"))
        try history("Google/Chrome", profile: "Default", urls: ["https://www.example.com/"])
        try history("Arc/User Data", profile: "Default", urls: [])
        XCTAssertNil(Detection.browserUsing(page, scratch: work, places: places, defaultBrowser: "com.apple.Safari"), "no ChatGPT visit")
        let state = ["profile": ["info_cache": ["Default": ["name": "Person A"], "Profile 2": ["name": "Work"]]]]
        try JSONSerialization.data(withJSONObject: state).write(to: places.support.appendingPathComponent("Google/Chrome/Local State"))
        try history("Google/Chrome", profile: "Profile 2", urls: ["https://chatgpt.com/c/abc"])
        XCTAssertEqual(Detection.browserUsing(page, scratch: work, places: places, defaultBrowser: "com.apple.Safari")?.lastPathComponent, "Google Chrome.app")
        XCTAssertNil(Detection.browserUsing(page, scratch: work, places: places, defaultBrowser: "com.google.Chrome"))
        try Data("not a database".utf8).write(to: places.support.appendingPathComponent("Arc/User Data/Default/History"))
        XCTAssertEqual(Detection.browserUsing(page, scratch: work, places: places, defaultBrowser: "com.apple.Safari")?.lastPathComponent, "Google Chrome.app")
        XCTAssertTrue(Detection.visited("chatgpt.com", history: places.support.appendingPathComponent("Google/Chrome/Profile 2/History"), scratch: work))
        XCTAssertFalse(Detection.visited("chatgpt.com", history: places.support.appendingPathComponent("Google/Chrome/Default/History"), scratch: work))
    }

    func testEachBrowserIsNamedAsTheHomeNamesIt() {
        let apps = ["chrome": "Google Chrome", "arc": "Arc", "dia": "Dia", "brave": "Brave Browser", "edge": "Microsoft Edge",
                    "vivaldi": "Vivaldi", "comet": "Comet", "chromium": "Chromium", "chrome-beta": "Google Chrome Beta"]
        XCTAssertEqual(Set(apps.keys), Set(Detection.families.map(\.id)), "a family with no app named here")
        for family in Detection.families {
            let home = apps[family.id].map { $0.replacingOccurrences(of: "^Google ", with: "", options: .regularExpression)
                .replacingOccurrences(of: " Browser$", with: "", options: .regularExpression) }
            XCTAssertEqual(family.name, home, family.id)
        }
    }

    func testAppsAreReadFromTheirBundlesAndBrowsersFromTheirOwnLocalState() throws {
        try app("Messages", id: "com.apple.MobileSMS")
        try app("WhatsApp", id: "desktop.WhatsApp", in: 1)
        try app("Wispr Flow", id: "com.example.wispr-flow-fake")
        try app("Google Chrome", id: "com.google.Chrome")
        try app("Google Chrome", id: "com.google.Chrome", in: 1)
        try app("Arc", id: "company.thebrowser.Browser")
        try app("Broken", id: nil)
        let state = places.support.appendingPathComponent("Google/Chrome")
        try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: ["profile": ["info_cache": [
            "Default": ["name": "Person A"], "Profile 2": ["name": ""], "Profile 10": ["name": "Work"],
            "Guest Profile": ["name": "Guest"], "System Profile": ["name": "System"],
        ]]]).write(to: state.appendingPathComponent("Local State"))

        let apps = Detection.apps(places)
        XCTAssertEqual(apps.filter { $0.id == "com.google.Chrome" }.count, 1, "the same app in two folders counted twice")
        XCTAssertFalse(apps.contains { $0.name == "Broken" })
        let browsers = Detection.browsers(apps, support: places.support)
        XCTAssertEqual(browsers.map(\.id), ["chrome", "arc"])
        XCTAssertEqual(browsers[0].profiles, [.init(id: "default", name: "Person A"), .init(id: "profile-2", name: "Profile 2"),
                                              .init(id: "profile-10", name: "Work")])
        XCTAssertEqual(browsers[1].profiles, [], "a browser never opened has no profiles yet")

        XCTAssertNil(Detection.browserApp("brave", places: places, registered: { _ in nil }))
        try app("Brave Browser", id: "com.brave.Browser", in: 1)
        let (family, url) = try XCTUnwrap(Detection.browserApp("brave", places: places, registered: { _ in nil }))
        XCTAssertEqual(family.bundle, "com.brave.Browser")
        XCTAssertEqual(url.lastPathComponent, "Brave Browser.app")
        XCTAssertEqual(Detection.browserApp("chrome", places: places, registered: { _ in nil })?.1.deletingLastPathComponent().path, places.applications[0].path)
        XCTAssertNil(Detection.browserApp("netscape", places: places, registered: { _ in nil }))
        let elsewhere = URL(fileURLWithPath: "/Volumes/Synthetic/Microsoft Edge.app")
        XCTAssertEqual(Detection.browserApp("edge", places: places, registered: { $0 == "com.microsoft.edgemac" ? elsewhere : nil })?.1,
                       elsewhere)

        try FileManager.default.createDirectory(at: Shots.e2e, withIntermediateDirectories: true)
        let record: [String: Any] = ["browsers": Detection.browsers(Detection.apps(places), support: places.support).map { browser in
                                         ["id": browser.id, "profiles": browser.profiles.map { "\($0.id) \($0.name)" }] as [String: Any]
                                     }]
        try JSONSerialization.data(withJSONObject: record, options: [.prettyPrinted, .sortedKeys])
            .write(to: Shots.e2e.appendingPathComponent("detection.json"))
    }
}
