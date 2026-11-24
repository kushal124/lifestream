#if os(macOS)
import Foundation
import SwiftUI
@testable import Cockpit

private let record = Data("""
{"source":"whatsapp","kind":"message","key":"chat-0001/0007","time":{"start":"2026-10-14T04:28:00Z","end":null},"from":{"handle":"+15550000001","label":"Mira Sen"},"text":"See you at the gym at ten","media":[],"reactions":[{"by":"me","emoji":"thumbs-up"}],"edited":false,"seq":184467}
""".utf8)

@MainActor private func fold(open: Bool) -> SourceFold {
    var fold = SourceFold(source: "WhatsApp · iPhone", kind: "message", key: "chat-0001/0007",
                          time: "2026-10-14T04:28:00Z", unit: "messages/chat-0001", json: record)
    fold.unfolded = open
    return fold
}

@MainActor let inspectorSheet = Sheet("inspector", ios: 390, mac: 400, hosted: true) {
    Specimen("Conversation, links, Open in, Source folded") {
        InspectorFrame("Mira Sen", icon: .message, when: "04:14–04:31 · 17m", where: "Home", source: "WhatsApp",
                       links: [InspectorLink(.person, "Mira Sen") {}, InspectorLink(.place, "Home") {}],
                       out: InspectorOut("Open in WhatsApp", url: URL(string: "https://wa.me/15550000001")!),
                       record: fold(open: false), close: {}) {
            Text("See you at the gym at ten").cockpit(.body).foregroundStyle(Cockpit.Color.text)
        }
        .frame(height: 330)
    }
    Specimen("A mail alone, at a place with no page") {
        InspectorFrame("Your statement is ready", icon: .mail, when: "21:44", where: "an unnamed place 4.1 km from Corner Gym",
                       source: "Gmail", out: InspectorOut("Open in Gmail", url: URL(string: "https://mail.google.com/mail/")!),
                       close: {}) {
            LetterHead("Synthetic Bank", address: "alerts@bank.example")
        }
        .frame(height: 240)
    }
    Specimen("Long title, Source open") {
        InspectorFrame("Northside Studio and Rehabilitation Centre, Bay 2 upstairs", icon: .place, when: "10:08–11:12 · 1h 4m",
                       where: "Northside Studio", source: "Location", record: fold(open: true)) {
            Meter("Time here today", value: "1h 4m", share: 0.4)
        }
        .frame(height: 620)
    }
    Specimen("No where, no links, no record") {
        InspectorFrame("6 mails", icon: .mail, when: "05:01") {
            Text("Example Bank, Shop Alerts and 4 more").cockpit(.subhead).foregroundStyle(Cockpit.Color.textSecondary)
        }
        .frame(height: 170)
    }
}

@MainActor let jsonTreeSheet = Sheet("json-tree", hosted: false) {
    Specimen("A record, open to depth 2") { Card { JSONTree(record) } }
    Specimen("Deep, folded below depth 2") {
        Card { JSONTree(Data(#"{"a":{"b":{"c":{"d":[1,2,3]}}},"list":[{"x":1},{"y":"a long string that wraps across the line because it is longer than the column"}],"n":null,"pi":3.14159,"t":true}"#.utf8)) }
    }
    Specimen("Not JSON") { Card { JSONTree(Data("<html>not json</html>".utf8)) } }
}
#endif
