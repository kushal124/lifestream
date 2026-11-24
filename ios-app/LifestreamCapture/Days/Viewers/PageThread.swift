import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct PageThread: View {
    let day: String
    let chat: String
    let group: Bool
    let marks: Set<String>
    @StateObject private var reading: PageReading<HomeLink.Pages.Thread>
    @State private var surface = NSObject()
    @State private var opening: PhotoViewer.Opening?
    @State private var attempt = 0
    @Environment(\.inspectorGo) private var go
    @Environment(\.scenePhase) private var scenePhase

    init(day: String, chat: String, group: Bool, marks: Set<String>) {
        self.day = day
        self.chat = chat
        self.group = group
        self.marks = marks
        _reading = StateObject(wrappedValue: PageReading(MomentReading.thread(chat: chat, day: day)))
    }

    var body: some View {
        Group {
            if let thread = reading.page {
                VStack(alignment: .leading, spacing: 0) {
                    PageNote(drawn: reading.drawn)
                    messages(thread.messages.enumerated().map { Self.message($0.offset, $0.element) })
                }
            } else if let failure = reading.failure {
                ReadLack(failure, lacks: "This isn't on this iPhone yet.", words: failure == .missing ? "This conversation is not in Lifestream." : nil,
                         retry: failure == .missing ? nil : { attempt += 1 })
            } else {
                Inspector.Bubbles().reading(true)
            }
        }
        .readsAgain(failed: { reading.failure }) { attempt += 1 }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { attempt += 1 }
        }
        .task(id: attempt) { await reading.read() }
        .onDisappear { NotePlayer.shared.stop(surface) }
        .photoViewer($opening) { go($0) }
    }

    private func messages(_ messages: [Shown]) -> some View {
        ScrollViewReader { scroll in
            LazyVStack(spacing: 2) {
                ForEach(Array(messages.enumerated()), id: \.element.id) { index, shown in
                    let previous = index > 0 ? messages[index - 1] : nil
                    if let clock = breakClock(shown, after: previous) { ThreadNote(clock: clock) }
                    if let event = shown.message.event {
                        ThreadNote(event)
                    } else {
                        bubble(shown, after: previous, in: messages)
                            .id(shown.id)
                            .padding(.top, previous.map { $0.message.mine != shown.message.mine ? Cockpit.Space.s2 : 0 }
                                ?? (named(shown) ? -Cockpit.Space.s2 : 0))
                    }
                }
            }
            .task(id: messages.map(\.key)) {
                if let marked = messages.first(where: { marks.contains($0.key) }) { scroll.scrollTo(marked.id, anchor: .center) }
            }
        }
    }

    static let breakMs: Int64 = 5 * 60_000

    private struct Shown: Identifiable {
        let id: Int
        let key: String
        let message: Inspector.ThreadMessage
    }

    private static func message(_ index: Int, _ said: HomeLink.Pages.DayMessage) -> Shown {
        var message = Inspector.ThreadMessage(id: index, ms: Int64(said.atMs), record: nil, speaker: said.mine ? "" : said.name,
                                              mine: said.mine, words: said.text)
        message.pictures = said.pictures.map(\.hash)
        message.missing = said.missing.map { $0 == .video ? "Video" : "Photo" }
        message.video = said.video
        message.sticker = said.sticker
        message.voice = said.voice.map { .init(hash: $0.audio, seconds: $0.seconds.map(Double.init), words: $0.transcript) }
        message.cards = said.attachments.map { .init(icon: $0.icon == .person ? .person : .file, title: $0.name, line: $0.line, url: nil) }
            + (said.link.map { link in [.init(icon: .link, title: link.title, line: URL(string: link.href)?.host(), url: URL(string: link.href))] } ?? [])
            + (said.location.map { place in [.init(icon: .location, title: place.name, line: "Open in Maps", url: maps(place))] } ?? [])
        message.quote = said.quote.map { MessageQuote(speaker: $0.mine ? "You" : $0.name, words: $0.text) }
        message.reactions = said.reactions.map(\.face)
        message.forwarded = said.forwarded
        message.edited = said.edited
        message.gone = said.gone
        message.event = said.event
        return Shown(id: index, key: said.key, message: message)
    }

    private static func maps(_ place: HomeLink.Pages.DayMessage.Location) -> URL? {
        var maps = URLComponents(string: "https://maps.apple.com/")
        maps?.queryItems = [URLQueryItem(name: "ll", value: "\(place.latitude),\(place.longitude)"), URLQueryItem(name: "q", value: place.name)]
        return maps?.url
    }

    private func named(_ shown: Shown) -> Bool {
        group && !shown.message.mine && !shown.message.speaker.isEmpty
    }

    private func breakClock(_ shown: Shown, after previous: Shown?) -> String? {
        guard let previous, let ms = shown.message.ms, let last = previous.message.ms, ms - last >= Self.breakMs else { return nil }
        return Words.clock(Date(timeIntervalSince1970: TimeInterval(ms) / 1000))
    }

    private func bubble(_ shown: Shown, after previous: Shown?, in messages: [Shown]) -> some View {
        let message = shown.message
        let speaker = named(shown) && (previous == nil || previous?.message.speaker != message.speaker || previous?.message.event != nil
            || breakClock(shown, after: previous) != nil) ? message.speaker : nil
        let marked = marks.contains(shown.key)
        return Group {
            if message.carries {
                MessageBubble(message.words, mine: message.mine, speaker: speaker, quote: message.quote, forwarded: message.forwarded,
                              edited: message.edited, gone: message.gone, reactions: message.reactions, marked: marked) {
                    media(message, in: messages)
                }
            } else {
                MessageBubble(message.words, mine: message.mine, speaker: speaker, quote: message.quote, forwarded: message.forwarded,
                              edited: message.edited, gone: message.gone, reactions: message.reactions, marked: marked)
            }
        }
        .accessibilityIdentifier("inspector.message.\(message.id)")
    }

    private func open(_ hash: String, in message: Inspector.ThreadMessage, of messages: [Shown]) {
        let held = { (each: Inspector.ThreadMessage) in each.pictures + (each.video.map { [$0] } ?? []) }
        let before = messages.prefix { $0.id != message.id }.flatMap { held($0.message) }
        opening = PhotoViewer.Opening(photos: messages.flatMap { held($0.message) }, at: before.count + (held(message).firstIndex(of: hash) ?? 0))
    }

    @ViewBuilder
    private func media(_ message: Inspector.ThreadMessage, in messages: [Shown]) -> some View {
        VStack(alignment: message.mine ? .trailing : .leading, spacing: 2) {
            if !message.pictures.isEmpty {
                MessagePictures(hashes: message.pictures) { open($0, in: message, of: messages) }
            }
            if let video = message.video {
                Button { open(video, in: message, of: messages) } label: {
                    PlaceShot.Picture(hash: video)
                        .frame(width: 240, height: 180)
                        .background(Cockpit.Color.well)
                        .clipShape(Bubble.shape)
                        .overlay(alignment: .bottomTrailing) { VideoMark(length: nil).padding(Cockpit.Space.s1) }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Video")
                .accessibilityHint("Plays it in the photo viewer")
                .accessibilityIdentifier("inspector.message.video")
            }
            if let sticker = message.sticker {
                Inspector.Picture(hash: sticker, width: 96, height: 96, fill: false).frame(width: 96, height: 96)
            }
            if let voice = message.voice {
                ThreadVoice(voice: voice, mine: message.mine, surface: surface)
                if !voice.words.isEmpty {
                    Text(voice.words)
                        .cockpit(.voice)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .multilineTextAlignment(message.mine ? .trailing : .leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 11)
                        .textSelection(.enabled)
                }
            }
            ForEach(Array(message.cards.enumerated()), id: \.offset) { _, card in
                if let url = card.url {
                    Link(destination: url) { MessageCard(card.title, icon: card.icon, line: card.line, mine: message.mine, opens: true) }
                        .buttonStyle(.plain)
                } else {
                    MessageCard(card.title, icon: card.icon, line: card.line, mine: message.mine)
                }
            }
            ForEach(message.missing, id: \.self) { what in
                HStack(spacing: Cockpit.Space.s2) {
                    Icon(what == "Video" ? .video : .photo, size: .sm)
                    Text("\(what) not in Lifestream").cockpit(.footnote)
                }
                .foregroundStyle(Cockpit.Color.textTertiary)
                .padding(.horizontal, 12)
                .frame(height: 32)
                .background { Bubble.shape.fill(Cockpit.Color.raised) }
            }
        }
    }
}
