import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI
import UIKit

enum FoldSize {
    static let afterFolded: CGFloat = 0
    static let afterMove: CGFloat = 0
    static let afterOpen: CGFloat = 8
    static let afterAllDay: CGFloat = 16
    static let staggered = 8
    static let stagger = Cockpit.Duration.stagger / 2
    static let rise: CGFloat = 4
}

struct DayPhoto: Identifiable, Hashable {
    let hash: String
    let atMs: Int?
    let alt: String?
    let video: Bool
    let durationMs: Int?
    let live: Bool

    var id: String { hash }

    init(_ photo: HomeLink.Pages.DayChapter.Photo) {
        hash = photo.hash
        atMs = photo.atMs
        alt = photo.alt
        video = photo.video
        durationMs = photo.durationMs
        live = false
    }

    init(_ tile: HomeLink.Pages.Tile) {
        hash = tile.hash
        atMs = tile.atMs
        alt = nil
        video = tile.video
        durationMs = tile.durationMs
        live = tile.live
    }

    var length: Double? { durationMs.map { Double($0) / 1000 } }

    var words: String {
        if video { return (["Video"] + [length.map(VideoClock.length)].compactMap { $0 }).joined(separator: ", ") }
        return alt ?? (live ? "Live Photo" : "Photo")
    }

    static func labels(_ photos: [DayPhoto]) -> (DayPhoto) -> String {
        { photo in
            let taken = photo.atMs.map { [Words.clock(Words.date(ms: Int64($0)))] } ?? []
            return ([photo.words] + taken + ["photo \((photos.firstIndex(of: photo) ?? 0) + 1) of \(photos.count)"]).joined(separator: ", ")
        }
    }
}

private struct PhotoTile: View {
    let photo: DayPhoto

    var body: some View {
        PlaceShot.Picture(hash: photo.hash)
            .overlay(alignment: .bottomTrailing) {
                if photo.video { VideoMark(length: photo.length) }
            }
    }
}

struct DayPiece: Identifiable {
    enum Owner: Equatable { case none, stay, move, track, also }

    enum Kind {
        case air(CGFloat)
        case allDayHeading
        case allDay(DayReading.Row)
        case head(DayReading.Chapter, index: Int, open: Bool)
        case alsoHead(HomeLink.Pages.Day.Also, index: Int, open: Bool)
        case names(DayReading.Chapter, index: Int)
        case photos(DayReading.Chapter, index: Int)
        case move(DayReading.Chapter, index: Int, open: Bool)
        case gap(DayReading.Chapter)
        case hour(DayReading.Block, chapter: Int, index: Int, open: Bool)
        case row(DayReading.Row, nested: Bool)
        case divider(String)
        case alsoHeading
        case now
        case plan(DayReading.Row)
        case dayEnd
    }

    let id: String
    let kind: Kind
    let owner: Owner
    let block: String?
    var rail = DayRail.none
    var stagger: Int?

    fileprivate var mark: Bool {
        switch kind {
        case .head(let chapter, _, _): chapter.kind == .stay
        case .move, .now, .plan: true
        default: false
        }
    }

    fileprivate var folding: Bool {
        switch kind {
        case .head(_, _, let open), .alsoHead(_, _, let open): !open
        default: false
        }
    }
}

struct DaySection: Identifiable {
    let id: String
    var header: [DayPiece]
    var pieces: [DayPiece]
}

struct DayLayout {
    let sections: [DaySection]

    static func of(_ page: HomeLink.Pages.Day, isOpen: @escaping (String, Bool) -> Bool, lead: CGFloat) -> DayLayout {
        var laying = Laying(page: page, isOpen: isOpen)
        laying.lay(lead: lead)
        return DayLayout(sections: laying.cut())
    }

    private struct Laying {
        let page: HomeLink.Pages.Day
        let isOpen: (String, Bool) -> Bool
        var pieces: [DayPiece] = []

        mutating func lay(lead: CGFloat) {
            add(.air(lead), id: "lead")
            if !page.allDay.isEmpty { add(.allDayHeading, id: "allday") }
            for row in page.allDay { add(.allDay(row), id: "allday:\(row.key)") }
            if !page.allDay.isEmpty { add(.air(FoldSize.afterAllDay), id: "after:allday") }
            var heads = 0, moves = 0
            for chapter in page.chapters {
                if let day = chapter.divider { add(.divider(day), id: "midnight") }
                switch chapter.kind {
                case .gap:
                    add(.gap(chapter), id: chapter.key)
                    add(.air(FoldSize.afterMove), id: "after:\(chapter.key)")
                case .move:
                    layMove(chapter, index: moves)
                    moves += 1
                case .day:
                    layRows(chapter, index: -1, owner: .track, stagger: false)
                    add(.air(FoldSize.afterOpen), id: "after:\(chapter.key)")
                case .stay, .none, .unknown:
                    layChapter(chapter, index: heads)
                    heads += 1
                }
            }
            if page.nowMs != nil {
                if let day = page.nowDivider { add(.divider(day), id: "midnight") }
                add(.now, id: "now")
                for plan in page.plans {
                    if let day = plan.divider { add(.divider(day), id: "midnight") }
                    add(.plan(plan), id: "plan:\(plan.key)")
                }
            }
            if let also = page.also {
                add(.alsoHeading, id: "also")
                let open = isOpen(DayReading.also, also.folded)
                add(.alsoHead(also, index: heads, open: open), id: "head:\(DayReading.also)", owner: .also, block: DayReading.also)
                if open {
                    for (at, row) in also.rows.enumerated() {
                        add(.row(row, nested: false), id: row.key, owner: .also, block: DayReading.also, stagger: at)
                    }
                    add(.air(FoldSize.afterOpen), id: "after:\(DayReading.also)", owner: .also, block: DayReading.also)
                } else {
                    add(.air(FoldSize.afterFolded), id: "after:\(DayReading.also)", owner: .also, block: DayReading.also)
                }
            }
            if page.endMs != nil { add(.dayEnd, id: "end") }
            draw()
        }

        private mutating func layChapter(_ chapter: DayReading.Chapter, index: Int) {
            let owner: DayPiece.Owner = chapter.kind == .stay ? .stay : .track
            let open = DayReading.opens(chapter) && isOpen(chapter.key, chapter.folded)
            add(.head(chapter, index: index, open: open), id: "head:\(chapter.key)", owner: owner, block: chapter.key)
            if open {
                layRows(chapter, index: index, owner: owner, stagger: true)
                add(.air(FoldSize.afterOpen), id: "after:\(chapter.key)")
            } else {
                if !chapter.names.isEmpty { add(.names(chapter, index: index), id: "names:\(chapter.key)", owner: owner, block: chapter.key) }
                if !chapter.photos.isEmpty { add(.photos(chapter, index: index), id: "photos:\(chapter.key)", owner: owner, block: chapter.key) }
                add(.air(FoldSize.afterFolded), id: "after:\(chapter.key)")
            }
        }

        private mutating func layMove(_ chapter: DayReading.Chapter, index: Int) {
            let open = DayReading.opens(chapter) && isOpen(chapter.key, chapter.folded)
            add(.move(chapter, index: index, open: open), id: "move:\(chapter.key)", owner: .move, block: chapter.key)
            if open {
                layRows(chapter, index: index, owner: .move, stagger: true)
                add(.air(FoldSize.afterOpen), id: "after:\(chapter.key)")
            } else {
                add(.air(FoldSize.afterMove), id: "after:\(chapter.key)")
            }
        }

        private mutating func layRows(_ chapter: DayReading.Chapter, index: Int, owner: DayPiece.Owner, stagger: Bool) {
            var shown = 0
            for (at, block) in chapter.blocks.enumerated() {
                guard block.kind == .hour else {
                    for row in block.rows {
                        if let day = row.divider { add(.divider(day), id: "midnight", owner: owner, block: chapter.key) }
                        add(.row(row, nested: false), id: row.key, owner: owner, block: chapter.key, stagger: stagger ? shown : nil)
                        shown += 1
                    }
                    continue
                }
                if let day = block.divider { add(.divider(day), id: "midnight", owner: owner, block: chapter.key) }
                let open = isOpen(block.key, block.folded)
                add(.hour(block, chapter: index, index: at, open: open), id: "hour:\(block.key)", owner: owner, block: chapter.key,
                    stagger: shown)
                shown += 1
                guard open else { continue }
                for row in block.rows {
                    if let day = row.divider { add(.divider(day), id: "midnight", owner: owner, block: chapter.key) }
                    add(.row(row, nested: true), id: row.key, owner: owner, block: chapter.key, stagger: shown)
                    shown += 1
                }
            }
        }

        private mutating func add(_ kind: DayPiece.Kind, id: String, owner: DayPiece.Owner = .none, block: String? = nil,
                                  stagger: Int? = nil) {
            var piece = DayPiece(id: id, kind: kind, owner: owner, block: block)
            piece.stagger = stagger
            pieces.append(piece)
        }

        private mutating func draw() {
            let marks = pieces.indices.filter { pieces[$0].mark }
            let first = marks.first { if case .plan = pieces[$0].kind { false } else { true } }
            let live = page.nowMs != nil
            let end: Int? = live
                ? pieces.indices.first { if case .now = pieces[$0].kind { true } else { false } }
                : marks.last { if case .plan = pieces[$0].kind { false } else { true } }
            let lastPlan = pieces.indices.last { if case .plan = pieces[$0].kind { true } else { false } }

            enum Stretch { case before, life, plan, after }
            var stretch = Stretch.before
            func line(_ stretch: Stretch, track: Bool) -> DayRail.Line {
                switch stretch {
                case .plan: .plan
                case .before, .after: track ? .track : .none
                case .life: track ? .track : .life
                }
            }
            for index in pieces.indices {
                let track = pieces[index].owner == .track
                let above = line(stretch, track: track)
                if index == first, stretch == .before { stretch = .life }
                if index == end { stretch = live && lastPlan != nil ? .plan : .after }
                if index == lastPlan { stretch = .after }
                pieces[index].rail = pieces[index].mark ? DayRail(above: above, below: line(stretch, track: track)) : .through(above)
                if pieces[index].owner == .also { pieces[index].rail = .none }
            }
        }

        func cut() -> [DaySection] {
            var sections: [DaySection] = []
            var current = DaySection(id: "start", header: [], pieces: [])
            var block: String?
            var folded = false
            func begin(_ next: DaySection) {
                if !current.header.isEmpty || !current.pieces.isEmpty { sections.append(current) }
                current = next
            }
            for piece in pieces {
                switch piece.kind {
                case .head, .alsoHead:
                    block = piece.block
                    folded = piece.folding
                    begin(DaySection(id: "block:\(piece.block ?? piece.id)", header: [piece], pieces: []))
                case .move:
                    block = piece.block
                    folded = false
                    begin(DaySection(id: "block:\(piece.block ?? piece.id)", header: [], pieces: [piece]))
                default:
                    if let key = block, piece.block != key {
                        block = nil
                        folded = false
                        begin(DaySection(id: "after:\(key)", header: [], pieces: [piece]))
                    } else if folded {
                        current.header.append(piece)
                    } else {
                        current.pieces.append(piece)
                    }
                }
            }
            begin(DaySection(id: "", header: [], pieces: []))
            return sections
        }
    }
}

struct FoldContext {
    let page: HomeLink.Pages.Day
    let today: String
    let selected: String?
    let lit: String?
    let clock: Int
    var naming: [String: PlacesSnapshot.Spot] = [:]
}

struct FoldActions {
    let toggle: (_ key: String, _ head: Bool) -> Void
    let toggleEvery: () -> Void
    let open: (_ row: String) -> Void
    let photo: (_ photos: [DayPhoto], _ at: Int) -> Void
    let held: @Sendable (_ key: String, _ pinned: Bool) -> Void
    let name: (_ spot: PlacesSnapshot.Spot) -> Void
}

struct DayList: View {
    let layout: DayLayout
    let context: FoldContext
    let act: FoldActions
    @State private var band = FoldBand()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ForEach(layout.sections) { section in
            if !section.header.isEmpty {
                Section {
                    pieces(section.pieces)
                } header: {
                    VStack(spacing: 0) { pieces(section.header) }
                }
            } else {
                Section {
                    pieces(section.pieces)
                }
            }
        }
    }

    private func pieces(_ pieces: [DayPiece]) -> some View {
        ForEach(pieces) { piece in
            self.piece(piece)
                .transition(entering(piece))
        }
    }

    private func entering(_ piece: DayPiece) -> AnyTransition {
        if case .head = piece.kind { return .identity }
        if reduceMotion { return .opacity.animation(.easeOut(duration: Cockpit.Duration.fast)) }
        guard let stagger = piece.stagger else { return .opacity }
        let delay = stagger < FoldSize.staggered ? Double(stagger) * FoldSize.stagger : 0
        return .asymmetric(
            insertion: .opacity.combined(with: .offset(y: FoldSize.rise))
                .animation(Cockpit.Ease.out(Cockpit.Duration.open).delay(delay)),
            removal: .opacity)
    }

    @ViewBuilder private func piece(_ piece: DayPiece) -> some View {
        switch piece.kind {
        case .air(let height):
            Color.clear.frame(height: height).frame(maxWidth: .infinity).dayRail(piece.rail)
                .accessibilityHidden(true)
        case .alsoHeading:
            SectionLabel(context.page.nowMs != nil ? "Also today" : "Also that day")
                .padding(.horizontal, Cockpit.Gap.edge)
                .padding(.top, Cockpit.Gap.section)
                .padding(.bottom, Cockpit.Space.s1)
        case .allDayHeading:
            SectionLabel("All day")
                .padding(.horizontal, Cockpit.Gap.edge)
                .padding(.bottom, Cockpit.Space.s1)
        case .allDay(let row):
            DayRow(.allDay(title: row.name, facts: Self.said(row.words).joined(separator: Words.dot)), time: nil, rail: piece.rail,
                   selected: context.selected == row.key) { act.open(row.key) }
                .accessibilityIdentifier("day.allday.\(Self.atom(row.key))")
        case .head(let chapter, let index, let open):
            head(chapter, index: index, open: open, piece: piece)
        case .alsoHead(let also, let index, let open):
            StayHead(also.names.map(\.text).joined(separator: ", "), time: nil, length: nil, glyph: nil,
                     state: open ? .open : .folded, rail: piece.rail, quiet: true,
                     held: open ? { @Sendable [held = act.held] pinned in held(DayReading.also, pinned) } : nil,
                     identifier: "day.stay.\(index)",
                     action: also.rows.isEmpty ? nil : { act.toggle(DayReading.also, true) })
                .id("head:\(DayReading.also)")
                .transition(.identity)
        case .names(let chapter, let index):
            BlockBand(band: band, key: chapter.key) {
                let lead = Self.lead(chapter, today: context.today)
                let icons = chapter.names.map { Self.icon(of: DayReading.first(of: $0, in: chapter)) }
                NamesLine(lead.map { [$0] + chapter.names.map(\.text) } ?? chapter.names.map(\.text),
                          icons: lead == nil ? icons : [.place] + icons, rail: piece.rail) { at in
                    if lead != nil, at == 0 { return act.toggle(chapter.key, true) }
                    act.open(chapter.names[lead == nil ? at : at - 1].firstRow)
                }
            }
            .accessibilityIdentifier("day.names.\(index)")
        case .photos(let chapter, let index):
            let photos = chapter.photos.map(DayPhoto.init)
            BlockBand(band: band, key: chapter.key) {
                PhotoStrip(photos, rail: piece.rail, label: DayPhoto.labels(photos), video: \.video,
                           open: { photo in act.photo(photos, photos.firstIndex(of: photo) ?? 0) }) { PhotoTile(photo: $0) }
            }
            .accessibilityIdentifier("day.photos.\(index)")
        case .move(let chapter, let index, let open):
            moveRow(chapter, index: index, open: open, piece: piece)
        case .gap(let chapter):
            if let head = chapter.head {
                DayRow(.item(icon: Cockpit.Icon(rawValue: head.icon) ?? .pause, name: head.title,
                             words: head.words.compactMap { Self.word($0, picture: { _ in nil }) }, quiet: head.quiet),
                       time: clock(chapter.startMs), rail: piece.rail, selected: context.lit == chapter.key)
                    .id(chapter.key)
                    .accessibilityIdentifier("day.gap.\(chapter.startMs)")
            }
        case .hour(let block, let chapter, let index, let open):
            DayRow(.hour(names: block.line ?? "", count: Self.count(block.count), open: open), time: clock(block.startMs), rail: piece.rail) {
                act.toggle(block.key, false)
            }
            .accessibilityIdentifier("day.hour.\(chapter).\(index)")
        case .row(let row, let nested):
            FoldRow(row: row, nested: nested, context: context, rail: piece.rail, open: act.open)
        case .divider(let day):
            DayRow(.divider(date: Words.longDay(day, today: context.today)), time: nil, rail: piece.rail)
                .accessibilityIdentifier("day.midnight")
        case .now:
            DayRow(.now(updated: context.page.updatedMs.map(clock)), time: clock(context.page.nowMs ?? 0), rail: piece.rail)
                .accessibilityIdentifier("day.now")
        case .plan(let row):
            let ahead = Words.ahead(Words.date(ms: Int64(row.atMs ?? 0)))
            DayRow(.plan(title: row.name, facts: ([ahead] + Self.said(row.words)).joined(separator: Words.dot), length: Self.length(row.count)),
                   time: row.atMs.map(clock), rail: piece.rail, selected: context.selected == row.key) { act.open(row.key) }
                .accessibilityIdentifier("day.plan.\(Self.atom(row.key))")
        case .dayEnd:
            let end = context.page.endMs ?? 0
            DayRow(.dayEnd(next: Words.shortDate(Words.date(ms: Int64(end)))), time: clock(end), rail: piece.rail)
                .accessibilityIdentifier("day.end")
        }
    }

    private func head(_ chapter: DayReading.Chapter, index: Int, open: Bool, piece: DayPiece) -> some View {
        let head = chapter.head
        let length = head?.length ?? (chapter.kind == .stay && chapter.endMs == nil ? "since " + clock(chapter.startMs) : nil)
        let led = !open && !chapter.names.isEmpty && Self.lead(chapter, today: context.today) != nil
        let line = led ? nil : Self.line(chapter, today: context.today).map(Arriving.words)
        let spot = context.naming[chapter.key]
        let opens = DayReading.opens(chapter)
        return StayHead(head?.title ?? "", time: clock(chapter.startMs), length: length, glyph: Self.glyph(chapter), line: line,
                        state: open ? .open : .folded, rail: piece.rail, unnamed: DayReading.unnamed(chapter),
                        tight: !open && !chapter.names.isEmpty,
                        held: open ? { @Sendable [held = act.held, key = chapter.key] pinned in held(key, pinned) } : nil,
                        pressing: open ? nil : { [band, key = chapter.key] in band.key = $0 ? key : nil },
                        identifier: "day.stay.\(index)",
                        nameIt: spot.map { spot in StayHead.NameIt(identifier: "day.nameit.\(index)") { act.name(spot) } },
                        action: opens ? { act.toggle(chapter.key, true) } : nil,
                        openEvery: opens ? act.toggleEvery : nil)
            .id("head:\(chapter.key)")
            .transition(.identity)
    }

    private func moveRow(_ chapter: DayReading.Chapter, index: Int, open: Bool, piece: DayPiece) -> some View {
        let head = chapter.head
        let names = chapter.names.isEmpty ? nil : chapter.names.map(\.text).joined(separator: ", ")
        let more = head?.words.lazy.compactMap { if case .text(let text, .tertiary, _) = $0 { text } else { nil } }.first
        let opens = DayReading.opens(chapter)
        return DayRow(.move(icon: Cockpit.Icon(rawValue: head?.icon ?? "") ?? .move, words: head?.title ?? "", more: more, names: names,
                            length: head?.length ?? "", open: opens ? open : nil),
                      time: clock(chapter.startMs), rail: piece.rail,
                      action: opens ? { act.toggle(chapter.key, false) } : nil)
            .id("head:\(chapter.key)")
            .accessibilityIdentifier("day.move.\(index)")
    }

    private func clock(_ ms: Int) -> String {
        Words.clock(Words.date(ms: Int64(ms)))
    }

    static func line(_ chapter: DayReading.Chapter, today: String) -> String? {
        guard chapter.kind == .stay, let head = chapter.head else { return nil }
        let since = head.sinceMs.map { ms -> String in
            let date = Words.date(ms: Int64(ms))
            return "since " + String(Words.weekdayName(ofDay: HomeClock.current.dayAt(Int64(ms)).day).prefix(3)) + " " + Words.clock(date)
        }
        let said = [head.line, since, head.statedBy].compactMap { $0 }.filter { !$0.isEmpty }
        return said.isEmpty ? nil : said.joined(separator: Words.dot)
    }

    static func lead(_ chapter: DayReading.Chapter, today: String) -> String? {
        guard !DayReading.unnamed(chapter) else { return nil }
        return line(chapter, today: today)
    }

    static func naming(_ page: HomeLink.Pages.Day, toName: [PlacesSnapshot.Spot]) -> [String: PlacesSnapshot.Spot] {
        var naming: [String: PlacesSnapshot.Spot] = [:]
        for chapter in page.chapters where DayReading.unnamed(chapter) {
            if let key = chapter.head?.place, let spot = toName.first(where: { $0.key == key }) { naming[chapter.key] = spot }
        }
        return naming
    }

    static func glyph(_ chapter: DayReading.Chapter) -> Cockpit.Icon? {
        guard chapter.kind == .stay, let head = chapter.head else { return nil }
        return head.icon == "home" ? .home : .place
    }

    static func icon(of row: DayReading.Row?) -> Cockpit.Icon {
        guard let row else { return .info }
        if row.kind == .conversation { return row.icon == "meeting" ? .people : .person }
        return Cockpit.Icon(rawValue: row.icon) ?? .info
    }

    static func atom(_ key: String) -> String {
        key.hasPrefix("e") ? String(key.dropFirst()) : key
    }

    static func said(_ words: [HomeLink.Pages.DayRun]) -> [String] {
        words.compactMap { run in
            switch run {
            case .text(let text, _, _), .quote(let text), .span(let text, _, _, _): text
            case .list(let items), .titles(let items): items.joined(separator: ", ")
            case .tiles, .unknown: nil
            }
        }
    }

    static func word(_ run: HomeLink.Pages.DayRun, picture: (String) -> Image?) -> DayWord? {
        switch run {
        case .text(let text, let tone, let title): tone == .tertiary || title ? .quiet(text) : .text(text)
        case .span(let text, let tone, _, _): tone == .tertiary ? .quiet(text) : .text(text)
        case .quote(let text): .quote(text)
        case .list(let items): .items(items)
        case .titles(let items): .quiet(items.joined(separator: ", "))
        case .tiles(let photos, let more): .tiles(photos.map { picture($0.hash) }, more: more)
        case .unknown: nil
        }
    }

    static func count(_ count: HomeLink.Pages.DayCount?) -> DayRow.Count? {
        switch count {
        case .words(let text)?: .text(text)
        case .sent(let n)?: .runs([.sent(n)])
        case .received(let n)?: .runs([.received(n)])
        case .unknown?, nil: nil
        }
    }

    static func length(_ count: HomeLink.Pages.DayCount?) -> String? {
        if case .words(let text)? = count { return text }
        return nil
    }
}

@Observable final class FoldBand {
    var key: String?
}

private struct BlockBand<Content: View>: View {
    let band: FoldBand
    let key: String
    @ViewBuilder let content: Content

    var body: some View { content.dayBand(band.key == key) }
}

private struct FoldRow: View {
    let row: DayReading.Row
    let nested: Bool
    let context: FoldContext
    let rail: DayRail
    let open: (String) -> Void
    @Environment(\.displayScale) private var scale

    private var tiles: [DayPhoto] {
        row.words.flatMap { run -> [DayPhoto] in if case .tiles(let photos, _) = run { photos.map(DayPhoto.init) } else { [] } }
    }

    var body: some View {
        let shots = row.kind == .photos ? tiles : []
        VStack(spacing: 0) {
            DayRow(kind(strip: !shots.isEmpty), time: row.atMs.map(clock), rail: rail, nested: nested,
                   selected: context.selected == row.key || context.lit == row.key, action: row.focus == nil ? nil : { open(row.key) })
            if !shots.isEmpty {
                PhotoStrip(shots, rail: rail, label: DayPhoto.labels(shots), video: \.video, open: { _ in open(row.key) }) { PhotoTile(photo: $0) }
            }
        }
        .task(id: shots.isEmpty ? tiles.map(\.hash) : []) { if shots.isEmpty { await read(tiles.map(\.hash)) } }
        .id(row.key)
        .accessibilityIdentifier("day.row.\(DayList.atom(row.key))")
    }

    private func kind(strip: Bool) -> DayRow.Kind {
        let picture = { (hash: String) in HomePictures.shared.picture(hash, .tile).map(Image.init(uiImage:)) }
        let words = row.words.filter { if strip, case .tiles = $0 { false } else { true } }.compactMap { DayList.word($0, picture: picture) }
        let note = row.note.isEmpty ? nil : row.note
        if strip, let many = DayList.length(row.count) {
            return .item(icon: DayList.icon(of: row), name: many, detail: note, words: words, quiet: row.quiet)
        }
        return .item(icon: DayList.icon(of: row), name: row.name, detail: note, words: words, count: DayList.count(row.count), quiet: row.quiet)
    }

    private func clock(_ ms: Int) -> String {
        Words.clock(Words.date(ms: Int64(ms)))
    }

    private func read(_ hashes: [String]) async {
        let side = Int((20 * scale).rounded(.up))
        await withTaskGroup(of: Void.self) { group in
            for hash in hashes { group.addTask { _ = try? await HomePictures.shared.read(hash, .tile, side: side) } }
        }
    }
}

struct FoldReading: View {
    var body: some View {
        VStack(spacing: 0) {
            stay("Harbour Home", line: "since Thu", names: ["Person A", "Group Alpha", "Mac 29m", "Person B", "Ask"], rail: .starts)
            DayRow(.move(icon: .move, words: "Drive 1.8 km", length: "5m"), time: "09:33")
            Color.clear.frame(height: FoldSize.afterMove).dayRail(.through)
            stay("Northside Studio", line: "first day", names: ["Music", "Workout 45m", "Person C", "Person D"], rail: .through)
            DayRow(.move(icon: .move, words: "Drive 1.5 km", length: "6m"), time: "10:51")
            Color.clear.frame(height: FoldSize.afterMove).dayRail(.through)
            stay("Harbour Home", line: "since 10:57", names: ["Mac 3h 49m", "Coding", "Person E", "Dictated", "Searched"],
                 rail: .ends)
        }
        .allowsHitTesting(false)
    }

    private func stay(_ name: String, line: Arriving, names: [String], rail: DayRail) -> some View {
        VStack(spacing: 0) {
            StayHead(name, time: "00:00", length: "1h 13m", glyph: .place, line: line, rail: rail, action: {})
            NamesLine(names, rail: rail == .ends ? .none : .through) { _ in }
            Color.clear.frame(height: FoldSize.afterFolded).dayRail(rail == .ends ? .none : .through)
        }
    }
}
