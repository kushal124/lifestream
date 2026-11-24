#if os(macOS)
import SwiftUI
@testable import Cockpit

@MainActor private func shot(_ width: CGFloat, _ height: CGFloat) -> some View {
    Bubble.shape.fill(Cockpit.Color.well)
        .overlay { Icon(.photo, size: .lg).foregroundStyle(Cockpit.Color.textTertiary) }
        .frame(width: width, height: height)
}

@MainActor let messageSheet = Sheet("message", ios: 390, mac: 440) {
    Specimen("One to one: words, a reply, a photo, a voice note, a place") {
        VStack(spacing: 2) {
            ThreadNote(clock: "08:10")
            MessageBubble("are you coming to the thing tonight?", mine: false)
            MessageBubble("yes, leaving at seven", mine: true, quote: MessageQuote(speaker: "Person A", words: "are you coming to the thing tonight?"))
            MessageBubble("", mine: false) { shot(220, 160) }
            MessageBubble("", mine: false, quote: MessageQuote(speaker: "You", words: "yes, leaving at seven")) {
                VoiceBar(seconds: 14, played: 0.35, playing: true) {}
            }
            MessageBubble("", mine: true) {
                MessageCard("Synthetic Cafe", icon: .location, line: "Open in Maps", mine: true, opens: true)
            }
            ThreadNote(clock: "09:02")
            MessageBubble("see https://example.com/plan", mine: false) {
                MessageCard("The plan", icon: .link, line: "example.com", opens: true)
            }
        }
    }
    Specimen("A group: names when the speaker changes, reactions, an event") {
        VStack(spacing: 2) {
            MessageBubble("who is bringing what", mine: false, speaker: "Person B", reactions: ["❤️ Person C", "👍 You"])
            MessageBubble("bread and the cheese", mine: false, speaker: "Person C")
            ThreadNote("Person B changed the group’s name")
            MessageBubble("I'll bring the drinks", mine: true)
        }
    }
    Specimen("Forwarded, edited, deleted, a file, the one a search opened") {
        VStack(spacing: 2) {
            MessageBubble("the address is on the card", mine: false, forwarded: true)
            MessageBubble("seven thirty, not seven", mine: true, edited: true)
            MessageBubble("", mine: false, gone: true)
            MessageBubble("", mine: false) { MessageCard("Itinerary", icon: .file, line: "PDF") }
            MessageBubble("the searched words, ringed", mine: true, marked: true)
            MessageBubble("", mine: false) { VoiceBar(seconds: 41, toggle: nil) }
        }
    }
}

@MainActor let letterSheet = Sheet("letter", ios: 390, mac: 440) {
    Specimen("Received") {
        LetterHead("Person A", address: "person-a@example.com", to: "to you", at: "09:41")
    }
    Specimen("Sent, to several") {
        LetterHead("You", address: "you@example.com", to: "to Person B, Person C and 2 more", at: "Mon 28 Sep · 18:02")
    }
    Specimen("A name alone") {
        LetterHead("Synthetic Bank", at: "05:01")
    }
}
#endif
