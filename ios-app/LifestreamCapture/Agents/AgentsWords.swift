import Cockpit
import Foundation
import HomeLink
import LifestreamCaptureCore

enum AgentsWords {
    static let page = "Agents"
    static let needsYou = "Needs you"
    static let connected = "Connected"
    static let inLifestream = "In Lifestream"
    static let review = "Review"
    static let access = "Access"
    static let reads = "Reads"
    static let howFarBack = "How far back"
    static let hides = "Hides"
    static let history = "History"
    static let seeAll = "See all"
    static let connection = "Connection"
    static let finer = "People, single chats and items"
    static let later = "Later"
    static let accounts = "Accounts"
    static let accountNote = "An account can read less than the rest, never more."
    static let custom = "Custom"
    static let hide = "Hide"
    static let hidden = "Hidden"
    static let unreached = "Can\u{2019}t reach Lifestream on your Mac."
    static let noneConnected = "None connected"
    static let disconnected = "Disconnected"
    static let stops = "Stops"
    static let stays = "Stays"
    static let removeFromList = "Remove from the list\u{2026}"
    static let remove = "Remove"
    static let whatItCanSee = "What it can see"
    static let thirtyDays = "30 days"
    static let keptFromIt = "Kept from it"
    static let whyItCould = "Why it could"
    static let showMore = "Show more"

    static func place(_ at: Int, of count: Int) -> String { "\(at) of \(count)" }

    static func connectedCount(_ count: Int) -> String { "\(count) connected" }

    static func count(_ reads: HomeLink.AccessView.KindReads) -> String { reads.n > 0 ? reads.n.formatted() : "\u{2014}" }

    static func accessOf(_ name: String) -> String { name + "\u{2019}s access" }

    static func more(_ count: Int) -> String { "Show \(count) more" }

    static func hiddenWith(_ type: String) -> String { "Hidden with " + type }

    static func level(_ hiding: HomeLink.AccessView.Hiding) -> String {
        hiding.choices.first { $0.level == hiding.choice }?.words ?? hiding.words
    }

    static func plain(_ runs: HomeLink.Bolded) -> String { runs.map(\.text).joined() }

    static func runs(_ bolded: HomeLink.Bolded) -> [BoldRun] { bolded.map { BoldRun($0.text, bold: $0.bold) } }

    static func time(_ ms: Int64) -> String {
        let at = Date(timeIntervalSince1970: Double(ms) / 1000)
        return Words.clock(at, zone: HomeClock.current.dayAt(at).zone)
    }
}

enum GuideWords {
    static let copy = "Copy"
    static let share = "Share"
    static let done = "Done"
    static let deny = "Don\u{2019}t allow"
    static let again = "Start again"
    static let check = "Check again"
    static let getting = "Getting your address\u{2026}"
    static let making = "Making the key\u{2026}"
}
