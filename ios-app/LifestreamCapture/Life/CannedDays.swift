import Foundation
import HomeLink
import LifestreamCaptureCore

enum CannedDays {
    static let location = "location:local:phone-aa01"

    static let quiet = [(group: CannedHome.quietGroups[0], count: 4), (group: CannedHome.quietGroups[1], count: 3)]

    static let quietHeading = "You were quiet in"

    static let chatMedia = [(file: "chat.table.jpg", video: false), (file: "chat.street.mov", video: true),
                            (file: "chat.menu.jpg", video: false), (file: "chat.door.mov", video: true)]

    fileprivate static let newest = 21

    static func days(_ routine: CannedHome.Routine) -> [HomeLink.DayFile] {
        whole(routine).map { Sketch(day: $0, routine: routine).file }
    }

    static func sleep(_ routine: CannedHome.Routine) -> [HomeLink.Extract] {
        whole(routine).compactMap { Sketch(day: $0, routine: routine).night }
    }

    static func file(_ day: String, _ routine: CannedHome.Routine) -> HomeLink.DayFile {
        Sketch(day: day, routine: routine).file
    }

    private static func whole(_ routine: CannedHome.Routine) -> [String] {
        Set((0..<newest).map(routine.day(back:)) + routine.trip).sorted()
    }
}


private struct Sketch {
    let day: String
    let routine: CannedHome.Routine
    let back: Int
    private let shape: Shape
    private let calendar: Calendar
    private let midnight: Date
    private let start: Date
    private let end: Date
    private var pending: [Pending] = []

    static let mac = "macbook-pro-0001"
    static let whatsapp = "whatsapp:15550000000:\(CannedHome.unit)"
    static let imessage = "imessage:+15550000090:\(CannedHome.unit)"
    static let voice = "voice-notes:local:\(CannedHome.unit)"
    static let gmail = "gmail:person-a@example.com:cloud"
    static let health = "apple-health:person-a@example.com:cloud"
    static let personA = ("whatsapp:15550000001@s.whatsapp.net", "Person A")
    static let personC = ("imessage:person-c@example.com", "Person C")
    static let group = ("whatsapp:120363000000000001@g.us", "Group Alpha")
    static let stanzas = [personA.0: "a", group.0: "alpha", personC.0: "c"]

    init(day: String, routine: CannedHome.Routine) {
        self.day = day
        self.routine = routine
        back = routine.back(of: day)
        calendar = .lane(routine.zone)
        midnight = routine.midnight(of: day)
        start = routine.start(of: day)
        end = routine.start(of: Words.shiftDay(day, 1))
        shape = Self.shape(of: day, back: back, routine: routine)
        write()
    }

    private var now: Date { routine.now }

    private struct Pending {
        let start: Date?
        let end: Date?
        let family: String
        let unit: String
        let text: String
        let block: HomeLink.DayFile.Block?
        let record: HomeLink.DayFile.RecordRef?
        let item: String?
        let flags: [String]
        var video: HomeLink.DayFile.Video? = nil
        var live: Bool? = nil
    }

    private enum Shape { case weekday, weekend, quiet, tripOut, tripAway, tripBack, past }

    private static func shape(of day: String, back: Int, routine: CannedHome.Routine) -> Shape {
        if let index = routine.trip.firstIndex(of: day) { return [.tripOut, .tripAway, .tripBack][index] }
        guard back < CannedDays.newest else { return .past }
        guard routine.isWeekend(day) else { return .weekday }
        return back == (7...13).first { routine.isWeekend(routine.day(back: $0)) } ? .quiet : .weekend
    }

    private var busy: Bool { shape == .weekday && back == (1...6).first { !routine.isWeekend(routine.day(back: $0)) } }

    private var phoneOff: Bool { day == routine.off }

    private var drift: Double { Double((back * 17) % 23) / 60 }


    var file: HomeLink.DayFile {
        let window = HomeLink.DayFile.Window(startMs: ms(start), endMs: ms(end))
        let cut = min(ms(now), window.endMs)
        let kept = pending.compactMap { atom -> Pending? in
            guard let start = atom.start, atom.family != "calendar", !atom.flags.contains("date_only") else { return atom }
            if ms(start) >= cut { return nil }
            guard let end = atom.end, ms(end) > cut else { return atom }
            let open = atom.family == "physical" && atom.text.hasPrefix("At ")
            let last = Date(timeIntervalSince1970: Double(cut) / 1000 - (open ? 180 : 0))
            return Pending(start: start, end: max(start, last), family: atom.family, unit: atom.unit,
                           text: open ? atom.text + " (still there at the last fix)" : atom.text, block: atom.block,
                           record: atom.record, item: atom.item, flags: atom.flags.filter { $0 != "continues_into_next_day" },
                           video: atom.video, live: atom.live)
        }
        let rank = { (atom: Pending) -> Int in
            atom.flags.contains("heading") ? 0 : atom.flags.contains("date_only") ? 2 : atom.flags.contains("no_time") ? 3 : 1
        }
        let ordered = kept.enumerated().sorted { left, right in
            (rank(left.element), left.element.start.map(ms) ?? 0, left.offset) < (rank(right.element), right.element.start.map(ms) ?? 0, right.offset)
        }.map(\.element)
        let atoms = ordered.enumerated().map { index, atom in
            HomeLink.DayFile.Atom(
                n: index + 1, family: atom.family, unit: atom.unit, startMs: atom.start.map(ms), endMs: atom.end.map(ms),
                localStart: atom.flags.contains("date_only") ? nil : atom.start.map(clock), localEnd: atom.end.map(clock),
                flags: atom.flags, text: atom.text, record: atom.record, item: atom.item, block: atom.block, video: atom.video,
                live: atom.live)
        }
        return HomeLink.DayFile(
            day: day, window: window, renderer: "5/canned/2",
            inputs: "sha256:canned-\(day)-\(atoms.count)-chosen-\(CannedHome.chosen.mark)",
            counts: .init(total: atoms.count, perFamily: Dictionary(grouping: atoms, by: \.family).mapValues(\.count)),
            coverage: Set(atoms.map(\.family)).sorted().map { family in
                .init(family: family, sources: [.init(source: "\(family):canned", read: cut < window.endMs ? .into : .through)])
            },
            atoms: atoms)
    }

    var night: HomeLink.Extract? {
        let (start, end) = sleepSpan
        guard end <= now else { return nil }
        let record: HomeLink.JSON = .object(["source": .string(Self.health), "kind": .string("sample"), "key": .string("sleep-\(day)")])
        return HomeLink.Extract(
            family: "health", unit: "sleep/\(Self.health)/sleep-\(day)", reading: "sha256:sleep-\(day)",
            content: .object(["kind": .string("sleep"), "record": record, "start_ms": .number(Double(ms(start))),
                              "end_ms": .number(Double(ms(end))), "nap": .bool(false), "stages": .null,
                              "efficiency": .null, "performance": .null, "respiratory_rate": .null]),
            startMs: ms(start), endMs: ms(end), days: [day], items: [])
    }

    private var sleepSpan: (Date, Date) {
        let late = shape == .weekend || shape == .quiet
        return (hour(-1 + drift), hour((late ? 7.8 : 6.4) + drift))
    }


    private mutating func write() {
        places()
        guard shape != .past else { return }
        let (asleep, woke) = sleepSpan
        heading("health", unit: "vitals/\(day)",
                "Vitals against the 14 days before: heart rate never above 104.2; steps \(Words.count(steps)) (median 6,020 over 14 prior days)")
        if woke <= now {
            let clocks = "\(clock(asleep).suffix(5))–\(clock(woke).suffix(5))"
            heading("health", unit: "sleep/\(Self.health)/sleep-\(day)",
                    "Sleep \(clocks), wake at \(clock(woke).suffix(5)): duration \(hm(woke.timeIntervalSince(asleep) / 3600))",
                    record: (Self.health, "sample", "sleep-\(day)"))
        }
        switch shape {
        case .weekday: weekday()
        case .weekend: weekend()
        case .quiet: quiet()
        case .tripOut, .tripAway, .tripBack: trip()
        case .past: break
        }
        if back == 0 { longShapes() }
        if CannedHome.crowd, back == 1 { crowd() }
        if !phoneOff {
            at(21.5 + drift, nil, "physical", unit: "report/checkin:local:phone-aa01/\(day)",
               "Check-in (moment): pleasant \(4 + back % 3)/7, energy \(2 + back % 4)/5, tense \(1 + back % 3)/5", record: ("checkin:local:phone-aa01", "report", "evening-\(day)"))
        }
        if back == 1 {
            for (group, count) in CannedDays.quiet {
                pending.append(Pending(start: nil, end: nil, family: "messages", unit: "\(day):\(group.chat)",
                                       text: "\(group.label) · \(count) messages",
                                       block: .init(key: group.chat, title: CannedDays.quietHeading), record: nil, item: nil, flags: ["no_time"]))
            }
        }
        let ahead = (now.timeIntervalSince(midnight) / 3600 + 1.5).rounded(.down)
        if back == 0, hour(ahead + 0.5) < end {
            at(ahead, ahead + 0.5, "calendar", unit: "person-a@example.com/call-\(day)",
               "Event “Call with Person A”, organiser person-a@example.com",
               record: ("google-calendar:person-a@example.com:cloud", "event", "call-\(day)"))
        }
    }

    private var steps: Int {
        switch shape {
        case .quiet: 1_204 + back * 37
        case .weekend: 9_800 + (back * 611) % 3_000
        default: 5_200 + (back * 1_373) % 4_000
        }
    }

    private mutating func places() {
        let (first, last) = (start, end)
        for piece in routine.pieces(of: day) {
            let text: String
            var flags: [String] = []
            if let spot = piece.at {
                text = "At \(spot.words)"
                if piece.start <= first { flags.append("continues_from_previous_day") }
                if piece.end >= last { flags.append("continues_into_next_day") }
            } else if let from = piece.from, let to = piece.to {
                let mode = piece.mode == "drive" ? "Road vehicle" : "Walk"
                text = "\(mode), \(from.words) → \(to.words), \(String(format: "%.1f", piece.distance / 1000)) km"
            } else {
                continue
            }
            pending.append(Pending(start: piece.start, end: piece.end, family: "physical", unit: piece.units[0], text: text,
                                   block: nil, record: nil, item: nil, flags: flags))
        }
    }

    private mutating func crowd() {
        for (index, member) in CannedHome.crowdMembers.enumerated() {
            message(9 + Double(index) * 0.25, (member.chat, member.name),
                    "\(member.name): \(CannedHome.crowdLines[index % CannedHome.crowdLines.count])")
        }
    }

    private mutating func weekday() {
        let d = drift
        healthRows()
        at(7.2 + d, 7.4 + d, "phone", unit: "0000BBBB-1111/\(day)", "iPhone: com.example.social 9 min, com.example.news 3 min",
           record: ("screen-time:person-a@example.com:\(Self.mac)", "app-focus", "focus-\(day)-1"))
        message(7.5 + d, Self.personA, "Person A: morning! up yet?")
        message(7.55 + d, Self.personA, "the user: yes, heading in soon")
        mail(8.1, "Mail from Synthetic Bank: “Statement ready” — notice, bank: statement ready (Synthetic Bank)")
        mail(8.6 + d, "Mail from Person C to the user: “Lunch this week?” — are you free Thursday")
        sitting(9.25, 11.9 + d, apps: "Xcode \(70 + back) min, Chrome 40 min, Notes 15 min", lines: [
            (9.25, 11.9 + d, "Summary: Wrote the quarterly plan and reviewed a pull request."),
            (9.25, 10.6, "Writing the plan [Quarterly plan] in Notes"),
            (10.6, 11.9 + d, "Reviewing a pull request [Code review] in Xcode"),
            (11.5, nil, "Did: Approved the pull request"),
        ], web: [(9.4, #"Chrome: visited docs.example 6 times: "Plan", "Roadmap" (on screen)"#)])
        message(10.1 + d, Self.group, "Person B: standup moved to half past")
        message(10.15 + d, Self.group, "Person A: ok")
        message(10.9 + d, Self.group, "the user: thanks both")
        message(11.05 + d, Self.group, "Person B: see you there")
        if back % 2 == 0 {
            at(12.1, 12.3, "calls", unit: "whatsapp:CALL-\(day)", "WhatsApp voice call with Person B, they called, 12 min",
               record: (Self.whatsapp, "call", "CALL-\(day)"))
        } else {
            at(12.5, 12.57, "calls", unit: "apple:CALL-\(day)", "Phone call with Person A, the user called, 4 min",
               record: ("apple-calls:person-a@example.com:\(Self.mac)", "call", "CALL-\(day)"))
        }
        sitting(13.5 + d, 16.4, apps: "Xcode \(120 - back) min, Safari 30 min", lines: [
            (13.5 + d, 16.4, "\(hm(16.4 - 13.5 - d)) at the Mac (\(Self.mac)) (account pending)"),
        ], web: [(14.2, #"Safari: visited news.example: "A story about synthetic weather""#)])
        mail(14.4 + d, "Mail from the user to Person C: “Re: Lunch this week?” — Thursday works")
        mail(15.0, "Mail from Synthetic Shop: “Your order shipped” — order, shipping: order on its way (Synthetic Shop)")
        mail(15.3 + d, "Mail from Person C to the user: “Re: Re: Lunch this week?” — great, see you then")
        if back % 3 != 2 {
            at(16.0, 16.5, "calendar", unit: "person-a@example.com/review-\(day)", "Event “Design review”, organiser person-c@example.com, 3 attendees",
               record: ("google-calendar:person-a@example.com:cloud", "event", "review-\(day)"))
        }
        at(16.75, nil, "web", unit: "\(Self.mac)/\(day)T20", #"visited maps.example: "Directions""#,
           block: ("web:\(Self.mac)/\(day)/Chrome/this Mac", "Chrome on \(Self.mac), outside a screen sitting"),
           record: ("chrome:default:\(Self.mac)", "page-visit", "maps-\(day)"))
        if back % 4 == 1 {
            at(17.2, 17.25, "notes", unit: "apple-notes:person-a@example.com/groceries", "Note “Groceries” written: [ ] eggs\n[ ] milk\n[ ] bread",
               record: ("apple-notes:person-a@example.com:\(Self.mac)", "note", "groceries"))
        }
        if back % 12 == 7 { aiChat(17.5) }
        if back % 3 == 0 { photos(18.2, ["a bowl of noodles on a wooden table", "the same bowl, closer"]) }
        if back % 4 == 2 { voiceNote(18.5, seconds: 38, "Remember to book the table for Friday.") }
        if back % 2 == 1 {
            at(20.0, 20.7, "listening", unit: "now-playing:local:\(Self.mac)/\(day)", "\(Self.mac): 9 tracks in Music — Artist A, Artist B, Artist C",
               record: ("now-playing:local:\(Self.mac)", "now-playing", "play-\(day)"))
        }
        message(21.0 + d, Self.personC, "Person C: did you see the game?")
        message(21.1 + d, Self.personC, "the user: not yet, no spoilers")
        if back % 3 == 1 || back == 0 { payment("−12.50", "CORNER CAFE", balance: "1,204.00") }
        if busy { busyOffice() }
    }

    private mutating func busyOffice() {
        for (hours, sender, subject) in [(9.55, "Synthetic Travel", "Fares for next month"), (10.45, "Person B", "Draft agenda"),
                                         (11.35, "Synthetic News", "Morning digest"), (13.2, "Synthetic Gym", "Class moved")] {
            mail(hours, "Mail from \(sender): “\(subject)”")
        }
        at(15.7, 15.8, "calls", unit: "apple:CALL-\(day)-2", "Phone call with Person C, they called, 6 min",
           record: ("apple-calls:person-a@example.com:\(Self.mac)", "call", "CALL-\(day)-2"))
        message(16.3, Self.personA, "Person A: are we still on for Friday?")
        for (index, media) in CannedDays.chatMedia.enumerated() {
            message(16.31 + Double(index) / 100, Self.personA, "Person A: " + (media.video ? "Video" : "Photo"),
                    item: CannedHome.CannedPages.hash(of: media.file).map { "photo:" + $0.dropFirst("sha256:".count) })
        }
        message(16.35, Self.personA, "the user: yes, booked")
    }

    private mutating func weekend() {
        let d = drift
        healthRows()
        at(10.85, 11.6, "health", unit: "workout/\(Self.health)/w-\(day)", "workout — Strength training, duration 0:45, strain 9.1",
           record: (Self.health, "sample", "workout-\(day)"))
        at(11.62, 11.95, "health", unit: "workout/\(Self.health)/y-\(day)", "workout — Yoga, duration 0:20",
           record: (Self.health, "sample", "yoga-\(day)"))
        photos(11.7, ["a sunny courtyard with plants", "a coffee cup on a bench", "the courtyard from the gate"])
        message(13.0 + d, Self.personC, "Person C: brunch next weekend?")
        message(13.1 + d, Self.personC, "the user: yes please")
        message(15.0, Self.group, "Person A: who is around tonight?")
        message(15.2, Self.group, "Person B: me")
        at(16.0, 16.0 + 50.0 / 60, "listening", unit: "spotify:person-a:cloud/\(day)", "Spotify on ios: Synthetic Episode \(12 + back) by Synthetic Show, 50 min",
           record: ("spotify:person-a:cloud", "play", "episode-\(day)"))
        at(18.0, 18.3, "calls", unit: "whatsapp:CALL-\(day)", "WhatsApp video call with Person A, the user called, 18 min",
           record: (Self.whatsapp, "call", "CALL-\(day)"))
        at(21.0, 21.4, "phone", unit: "0000BBBB-1111/\(day)", "iPhone: com.example.video 20 min, com.example.social 4 min",
           record: ("screen-time:person-a@example.com:\(Self.mac)", "app-focus", "focus-\(day)-2"))
        payment("−48.00", "SYNTHETIC GROCER", balance: "1,156.00")
    }

    private mutating func quiet() {
        message(17.0, Self.personA, "Person A: all good?")
        message(17.3, Self.personA, "the user: resting today")
    }

    private mutating func trip() {
        switch shape {
        case .tripOut:
            message(9.1, Self.group, "the user: on the road")
            message(9.2, Self.group, "Person B: safe travels")
        case .tripBack:
            message(16.1, Self.group, "the user: heading home")
            message(16.2, Self.group, "Person B: drive safe")
        default:
            message(10.4, Self.personA, "Person A: how is the old town?")
            message(10.5, Self.personA, "the user: lovely, photos later")
        }
        if shape != .tripBack {
            photos(14.0, ["a wide street in the old town", "a market stall with fruit"], video: "the square at noon",
                   then: ["a courtyard with plants by the fountain"])
        }
        mail(15.0, "Mail from Synthetic Hotel: “Your stay” — travel, hotel: booking confirmed (Synthetic Hotel)")
        if shape == .tripBack { voiceNote(20.0, seconds: 21, "Back home. The trip was good.") }
    }


    private mutating func healthRows() {
        let block = ("health/iPhone steps", "iPhone steps")
        at(7.0, 7.25, "health", unit: "span/\(Self.health)/\(day)/1", "steps 320", block: block)
        at(7.25, 7.5, "health", unit: "span/\(Self.health)/\(day)/2", "steps 1,140", block: block)
        at(8.0, 9.0, "health", unit: "phone/screen-time:local:phone-aa01/\(day)", "Phone: 14 min, Social 9 min, Utilities 5 min")
    }

    private mutating func message(_ hours: Double, _ chat: (String, String), _ text: String, stanza: String? = nil, item: String? = nil) {
        let network = String(chat.0.prefix { $0 != ":" })
        let id = String(chat.0.dropFirst(network.count + 1))
        let said = stanza ?? "\(Self.stanzas[chat.0] ?? "m")-\(day)-\(Int((hours * 600).rounded()))"
        at(hours, nil, "messages", unit: "\(day):\(chat.0)", text, block: chat,
           record: network == "imessage" ? (Self.imessage, "msg", said) : (Self.whatsapp, "msg", "\(id):\(said)"), item: item)
    }

    private mutating func mail(_ hours: Double, _ text: String) {
        at(hours, nil, "mail", unit: "\(Self.gmail)/\(day)", text, record: (Self.gmail, "mailmsg", "mail-\(day)-\(Int(hours * 60))"))
    }

    private mutating func sitting(_ from: Double, _ to: Double, apps: String, lines: [(Double, Double?, String)], web: [(Double, String)]) {
        let unit = "\(Self.mac)/\(ms(hour(from)))"
        for (start, end, text) in lines { at(start, end, "screen", unit: unit, text, block: (unit, "Screen: \(apps)"), item: unit) }
        for (time, text) in web {
            at(time, nil, "web", unit: "\(Self.mac)/\(day)T\(Int(time))", text,
               block: (unit, "Web in the \(clock(hour(from)).suffix(5)) sitting on \(Self.mac)"),
               record: ("chrome:default:\(Self.mac)", "page-visit", "visit-\(day)-\(Int(time * 60))"))
        }
    }

    private mutating func photos(_ hours: Double, _ captions: [String], video: String? = nil, then: [String] = []) {
        let unit = "burst/\(ms(hour(hours)))"
        let shots = captions.map { ($0, false) } + (video.map { [($0, true)] } ?? []) + then.map { ($0, false) }
        let block = shots.count > 1 ? (unit, "Photos") : nil
        for (index, (words, moving)) in shots.enumerated() {
            let time = hours + Double(index) / 120
            if moving {
                at(time, nil, "photos", unit: unit, "Video: \(words)", block: block,
                        item: "photo:" + CannedHome.video.hash.dropFirst("sha256:".count), video: .init(durationMs: 4000))
            } else {
                let scene = CannedHome.scene(for: words)
                at(time, nil, "photos", unit: unit, "Photo: \(words)", block: block, item: "photo:" + scene.dropFirst("sha256:".count),
                   live: scene == CannedHome.scene(.park) ? true : nil)
            }
        }
    }

    private mutating func aiChat(_ hours: Double) {
        let source = "chatgpt:person-a@example.com:cloud"
        let key = "chat-\(day)"
        let block = ("\(source)/\(key)", "ChatGPT · Sourdough starter")
        at(hours, nil, "ai", unit: "\(source)/\(key)", "the user: How often should a sourdough starter be fed in a warm kitchen?",
           block: block, record: (source, "turn", "\(key)-1"))
        at(hours + 0.02, nil, "ai", unit: "\(source)/\(key)", "ChatGPT: Once a day in a warm kitchen, at the same hour, keeping a spoonful back.",
           block: block, record: (source, "turn", "\(key)-2"))
    }

    private mutating func voiceNote(_ hours: Double, seconds: Int, _ words: String) {
        let key = "voice-\(day)"
        let made = CannedHome.chosen.transcript(of: key, routine: routine)
        at(hours, hours + Double(seconds) / 3600, "voice", unit: "voice:local:phone-aa01/\(key)",
           "Voice note, \(seconds) s" + (made.by == nil ? "" : ": \(words)"),
           record: (Self.voice, "voice", key), item: "voice:\(key)")
    }

    private mutating func longShapes() {
        pending.append(Pending(start: Calendar.lane(TimeZone(secondsFromGMT: 0)!).midnight(of: day), end: nil, family: "calendar",
                               unit: "person-a@example.com/stay-\(day)",
                               text: "Event “Stay at Synthetic Harbour Residences @ Northern Coast Bay, Block C”, organiser Person Alpha Bravo Longfamilyname",
                               block: nil, record: .init(source: "google-calendar:person-a@example.com:cloud", kind: "event", key: "stay-\(day)"),
                               item: nil, flags: ["date_only"]))
        pending.append(Pending(start: Calendar.lane(TimeZone(secondsFromGMT: 0)!).midnight(of: day), end: nil, family: "calendar",
                               unit: "person-a@example.com/holiday-\(day)", text: "Event “Synthetic Festival (Day Two)”",
                               block: nil, record: .init(source: "google-calendar:person-a@example.com:cloud", kind: "event", key: "holiday-\(day)"),
                               item: nil, flags: ["date_only"]))
        let run = ["the user: happy festival!", "the user: what's the plan tonight", "Person A: Happy festival to you too",
                   "Person A: Just woke up", "Person A: Heading to the market", "Person A: Cooking for everyone later",
                   "Person A: Come by after seven?", "the user: yes, bringing dessert", "Person A: Perfect",
                   "Person A: Bring the synthetic cake from last time", "Person A: and a jacket, it gets cold on the terrace"]
        for (index, line) in run.enumerated() {
            message(index < 2 ? 15.45 + Double(index) / 60 : 15.75 + Double(index - 2) / 60, Self.personA, line)
        }
        let surnames = ["Synthetic", "Example-Longname", "Fixture", "Testcase", "Placeholder", "Sample"]
        for index in 0..<24 {
            let group = index % 4 == 3
            let chat = group ? ("whatsapp:1203630000000\(index)@g.us", "Synthetic Group \(index + 1)")
                : ("whatsapp:155500011\(String(format: "%02d", index))@s.whatsapp.net",
                   "Person \(Character(UnicodeScalar(UInt8(68 + index % 22)))) \(surnames[index % surnames.count])")
            message(20 + Double(index) / 60, chat, "\(group ? "Person Q" : chat.1): see you at the synthetic gathering", stanza: "crowd-\(day)-\(index)")
        }
    }

    private mutating func payment(_ amount: String, _ merchant: String, balance: String) {
        pending.append(Pending(start: Calendar.lane(TimeZone(secondsFromGMT: 0)!).midnight(of: day), end: nil, family: "money",
                               unit: "bank:acct-aa11:export/\(day)", text: "\(amount) USD Synthetic Bank ··0001: \(merchant) (balance \(balance))",
                               block: nil, record: .init(source: "bank:acct-aa11:export", kind: "txn", key: "txn-\(day)"),
                               item: nil, flags: ["date_only"]))
    }

    private mutating func heading(_ family: String, unit: String, _ text: String, record: (String, String, String)? = nil) {
        pending.append(Pending(start: nil, end: nil, family: family, unit: unit, text: text, block: nil,
                               record: record.map { .init(source: $0.0, kind: $0.1, key: $0.2) }, item: nil, flags: ["heading"]))
    }

    private mutating func at(_ from: Double, _ to: Double?, _ family: String, unit: String, _ text: String,
                             block: (String, String)? = nil, record: (String, String, String)? = nil, item: String? = nil,
                             flags: [String] = [], video: HomeLink.DayFile.Video? = nil, live: Bool? = nil) {
        pending.append(Pending(start: hour(from), end: to.map(hour), family: family, unit: unit, text: text,
                               block: block.map { .init(key: $0.0, title: $0.1) },
                               record: record.map { .init(source: $0.0, kind: $0.1, key: $0.2) }, item: item, flags: flags,
                               video: video, live: live))
    }


    private func hour(_ hours: Double) -> Date { midnight.addingTimeInterval((hours * 3600).rounded()) }

    private func ms(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded(.down)) }

    private func clock(_ date: Date) -> String {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        let hm = String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        let civil = calendar.civil(date)
        return civil == day ? hm : "\(civil) \(hm)"
    }

    private func hm(_ hours: Double) -> String {
        let minutes = Int((hours * 60).rounded())
        return "\(minutes / 60):\(String(format: "%02d", minutes % 60))"
    }
}

private extension Calendar {
    static func lane(_ zone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar
    }

    func civil(_ date: Date) -> String {
        let parts = dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    func midnight(of day: String) -> Date {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        return date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) ?? Date(timeIntervalSince1970: 0)
    }
}
