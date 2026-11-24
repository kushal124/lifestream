import Cockpit
import Foundation
import HomeLink

extension Inspector {
    struct ThreadMessage: Identifiable {
        struct Voice {
            let hash: String?
            let seconds: Double?
            let words: String
        }

        struct Card {
            let icon: Cockpit.Icon
            let title: String
            let line: String?
            let url: URL?
        }

        let id: Int
        let ms: Int64?
        let record: HomeLink.DayFile.RecordRef?
        let speaker: String
        let mine: Bool
        var words: String
        var pictures: [String] = []
        var missing: [String] = []
        var video: String?
        var sticker: String?
        var voice: Voice?
        var cards: [Card] = []
        var quote: MessageQuote?
        var reactions: [String] = []
        var forwarded = false
        var edited = false
        var gone = false
        var event: String?

        var carries: Bool { !pictures.isEmpty || video != nil || sticker != nil || voice != nil || !cards.isEmpty || !missing.isEmpty }
    }
}
