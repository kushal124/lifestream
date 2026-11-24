import Foundation
import XCTest
@testable import Cockpit

final class AskTraceTests: XCTestCase {
    private typealias Timed = (at: TimeInterval, event: AskTrace.Event)

    private static let dwell = Cockpit.Duration.dwell
    private static let quiet = Cockpit.Duration.quiet

    private static func bursts(_ text: String, from start: TimeInterval, size: Int = 24, gap: TimeInterval = 0.2) -> [Timed] {
        var events: [Timed] = []
        var rest = Substring(text)
        var at = start
        while !rest.isEmpty {
            events.append((at, .text(String(rest.prefix(size)))))
            rest = rest.dropFirst(size)
            at += gap
        }
        return events
    }

    private static func search(_ call: Int, _ start: TimeInterval, _ end: TimeInterval, _ scope: String, _ query: String,
                               failed: Bool = false) -> [Timed] {
        [(start, .began(call: call, words: "Searching \(scope) for “\(query)”")),
         (end, .ended(call: call, words: "Searched \(scope) for “\(query)”", failed: failed))]
    }

    private static func step(_ call: Int, _ start: TimeInterval, _ end: TimeInterval, _ going: String, _ done: String,
                             failed: Bool = false) -> [Timed] {
        [(start, .began(call: call, words: going)), (end, .ended(call: call, words: done, failed: failed))]
    }

    private static func sorted(_ events: [Timed]) -> [Timed] {
        events.enumerated().sorted { ($0.element.at, $0.offset) < ($1.element.at, $1.offset) }.map(\.element)
    }

    private struct Played {
        let frames: [(at: TimeInterval, frame: AskTrace.Frame)]
        let trace: AskTrace

        var lines: [(at: TimeInterval, line: AskTrace.Line?)] {
            var lines: [(at: TimeInterval, line: AskTrace.Line?)] = []
            for (at, frame) in frames where lines.last.map({ $0.line != frame.line }) ?? true { lines.append((at, frame.line)) }
            return lines
        }

        func frame(at time: TimeInterval) -> AskTrace.Frame {
            frames.last { $0.at <= time + 1e-9 }!.frame
        }

        var phrases: [String] {
            lines.compactMap { if case let .working(words)? = $0.line { words } else { nil } }
        }
    }

    private static func play(_ events: [Timed], until end: TimeInterval, every step: TimeInterval = 0.01) -> Played {
        var trace = AskTrace(asked: 0)
        var pending = sorted(events)[...]
        var frames: [(at: TimeInterval, frame: AskTrace.Frame)] = []
        var at = 0.0
        while at <= end {
            while let next = pending.first, next.at <= at {
                trace.take(next.event, at: next.at)
                pending = pending.dropFirst()
            }
            frames.append((at, trace.frame(at: at)))
            at = (at + step).rounded(toPlaces: 3)
        }
        return Played(frames: frames, trace: trace)
    }

    private static let quick: [Timed] = [(0.05, .named)] + search(1, 0.3, 1.1, "messages", "birthday dinner")
        + bursts("Your birthday dinner is on **Saturday 21 November** at 20:00 [r1]. Person A booked a table for six [r2].", from: 1.9)
        + [(4.6, .done("Your birthday dinner is on **Saturday 21 November** at 20:00 [r1]. Person A booked a table for six [r2]."))]

    private static let typicalText = """
        You went to **Synthetic Gym** nine times this month, mostly on weekday evenings [r1, r2]. Person A joined you for four of those [r3].

        Your longest session was on 11 November [r4].

        - **3 Nov**, evening, with Person A [r3]
        - **6 Nov**, morning, alone [r1]
        - **11 Nov**, the long session [r4]
        """

    private static let typical: [Timed] = [(0.02, .named)]
        + search(1, 0.2, 0.6, "messages", "Synthetic Gym") + search(2, 0.28, 1.38, "calendar", "gym") + search(3, 0.35, 3.15, "places", "Synthetic Gym")
        + step(4, 5.65, 6.4, "Reading the chat with Person A, 3 Nov", "Read the chat with Person A, 3 Nov")
        + step(5, 6.5, 6.62, "Counting workouts by month", "Counted workouts by month")
        + bursts(typicalText, from: 10.62)
        + [(14.4, .done(typicalText))]

    private static let long: [Timed] = [(0.02, .named), (1.5, .began(call: 1, words: "Searching workouts for “run”", said: "Let me look through your runs and messages first")),
        (2.3, .ended(call: 1, words: "Searched workouts for “run”", failed: false))] + search(2, 1.56, 3.1, "messages", "run")
        + step(3, 3.9, 4.7, "Counting workouts by week", "Counted workouts by week")
        + step(4, 8.0, 9.8, "Reading the chat with Person B", "Couldn’t read the chat with Person B", failed: true)
        + bursts("Your running picked up through October [r1].\n\n## By week\n\n- **27 Oct**: two short runs [r1]", from: 12)
        + [(15, .done("Your running picked up through October [r1].\n\n## By week\n\n- **27 Oct**: two short runs [r1]"))]

    func testSendingUntilTheHomeNamesTheTurnThenThinkingWithNoQuietWait() {
        let played = Self.play([(0.1, .named)], until: 2)
        XCTAssertEqual(played.frame(at: 0).line, .working("Sending"))
        XCTAssertEqual(played.frame(at: 0.64).line, .working("Sending"), "Sending stays its dwell")
        XCTAssertEqual(played.frame(at: Self.dwell).line, .working("Thinking"), "Thinking at once once the dwell is over")
        XCTAssertEqual(played.phrases, ["Sending", "Thinking"])
    }

    func testEveryPhraseStaysItsDwellOnEachTimeline() {
        for (name, events, end) in [("quick", Self.quick, 6.0), ("typical", Self.typical, 16.0), ("long", Self.long, 17.0)] {
            let lines = Self.play(events, until: end).lines
            for (index, line) in lines.enumerated().dropFirst() {
                guard case .working = lines[index - 1].line, case .working = line.line else { continue }
                XCTAssertGreaterThanOrEqual(line.at - lines[index - 1].at, Self.dwell - 1e-6,
                                            "\(name): \(String(describing: lines[index - 1].line)) flashed before \(String(describing: line.line))")
            }
        }
    }

    func testParallelStepsShowTheNewestOpenAndSkipOneThatEndedBeforeItsTurn() {
        let played = Self.play(Self.typical, until: 16)
        XCTAssertEqual(played.frame(at: Self.dwell).line, .working("Searching places for “Synthetic Gym”"), "the newest open of three")
        XCTAssertFalse(played.phrases.contains("Searching messages for “Synthetic Gym”"), "ended before its turn, a newer one waiting")
        XCTAssertFalse(played.phrases.contains("Searching calendar for “gym”"), "open, but a newer open one won")
    }

    func testAStepOf120MsNeverFlashes() {
        let played = Self.play(Self.typical, until: 16)
        let shown = played.lines.firstIndex { $0.line == .working("Counting workouts by month") }
        let at = try! XCTUnwrap(shown.map { played.lines[$0].at })
        XCTAssertGreaterThanOrEqual(played.lines[shown! + 1].at - at, Self.dwell - 1e-6, "it stays its dwell though it ended in 120 ms")
    }

    func testThinkingOnlyAfterTheQuietWithNoStepOpen() {
        let played = Self.play(Self.typical, until: 16)
        let thinking = played.lines.filter { $0.line == .working("Thinking") }.map(\.at)
        XCTAssertEqual(thinking.count, 2, "never between steps the dwell joins, only in the gaps after them: \(thinking)")
        XCTAssertEqual(thinking[0], 3.15 + Self.quiet, accuracy: 0.011, "the quiet after the last open step ended")
        XCTAssertEqual(thinking[1], 6.62 + Self.quiet, accuracy: 0.011)
    }

    func testTheHomesNarrationIsTheLinesNextPhraseBeforeItsStep() {
        let played = Self.play(Self.long, until: 17)
        XCTAssertEqual(played.phrases.prefix(3), ["Sending", "Thinking", "Let me look through your runs and messages first"])
        XCTAssertEqual(played.frame(at: 1.6).line, .working("Let me look through your runs and messages first"))
        XCTAssertEqual(played.frame(at: 1.6).markdown, "")
        XCTAssertEqual(played.frame(at: 1.5 + Self.dwell).line, .working("Searching messages for “run”"), "the step next")
    }

    func testTheAnswerStartingWhileAStepIsOpen() {
        let events: [Timed] = [(0.02, .named)] + Self.step(1, 0.5, 6, "Reading Sat 3 Oct", "Read Sat 3 Oct") + [(1, .text("You walked 9 km. "))]
        let played = Self.play(events, until: 4)
        XCTAssertEqual(played.frame(at: 1.05).line, .thought(ms: 1_000), "the first word shows though a step is open")
        XCTAssertTrue(played.frame(at: 3).markdown.hasPrefix("You walked"))
    }

    func testTextAfterThoughtForRollsBackToWorkThenToThoughtForAgain() {
        let first = "You slept 7 h on Monday.\n\n"
        let events: [Timed] = [(0.02, .named), (1, .text(first))]
            + Self.step(1, 3, 4, "Reading Tue 4 Nov", "Read Tue 4 Nov")
            + [(4.2, .text("And 8 h on Tuesday.")), (7, .done(first + "And 8 h on Tuesday."))]
        let played = Self.play(events, until: 8)
        XCTAssertEqual(played.frame(at: 2).line, .thought(ms: 1_000))
        XCTAssertEqual(played.frame(at: 3).line, .working("Reading Tue 4 Nov"), "back to work")
        XCTAssertEqual(played.frame(at: 4.21).line, .thought(ms: 4_200), "Thought for again, to the first text after the step")
        XCTAssertEqual(played.trace.frame(at: 8).markdown, first + "And 8 h on Tuesday.", "nothing taken back")
    }

    func testAnswerTextOnlyGrowsAndNeverShowsARawMark() {
        for (name, events, end) in [("quick", Self.quick, 6.0), ("typical", Self.typical, 16.0), ("long", Self.long, 17.0)] {
            var before = ""
            for (at, frame) in Self.play(events, until: end).frames {
                let shown = frame.markdown
                XCTAssertEqual(shown.components(separatedBy: "**").count % 2, 1, "\(name) at \(at): an open bold: \(shown)")
                XCTAssertNil(shown.firstMatch(of: /\[r\d*(?:,\s*r?\d*)*$/), "\(name) at \(at): half a citation: \(shown)")
                XCTAssertNil(shown.firstMatch(of: /(?:^|\n)\s*(?:[-*+]|#{1,6}|\d+\.)\s*$/), "\(name) at \(at): a bare marker: \(shown)")
                let grown = Self.unclosed(shown)
                XCTAssertTrue(grown.hasPrefix(Self.unclosed(before)), "\(name) at \(at): \(before) became \(shown)")
                before = shown
            }
        }
    }

    func testAListItemIsAListItemFromItsFirstWord() {
        let text = "Three visits:\n\n- **3 Nov**, evening\n- **6 Nov**, morning"
        let played = Self.play([(0.02, .named), (1, .text(text)), (3, .done(text))], until: 4, every: 0.001)
        let shown = played.frames.map(\.frame.markdown)
        XCTAssertTrue(shown.contains("Three visits:\n\n- **3**"), "the item and its bold from the first word: \(Set(shown).sorted())")
        XCTAssertFalse(shown.contains { $0.hasSuffix("\n-") || $0.hasSuffix("\n- ") })
    }

    func testTablesAndCodeArriveWhole() {
        let table = "Nights:\n\n| Night | Asleep |\n|---|---|\n| Mon | 8 h |\n\nThat is all."
        let played = Self.play([(0.02, .named), (1, .text(table)), (3, .done(table))], until: 4, every: 0.001)
        for markdown in Set(played.frames.map(\.frame.markdown)) where markdown.contains("|") {
            XCTAssertTrue(markdown.contains("| Mon | 8 h |"), "a table shows whole: \(markdown)")
        }
    }

    func testThePaceIsEvenAndNeverFarBehind() {
        let text = String(repeating: "Here is a word or two. ", count: 40)
        let events: [Timed] = [(0.02, .named), (0.5, .text("\n\n"))] + Self.bursts(text, from: 0.5, size: 60, gap: 0.1)
            + [(0.5 + 0.1 * Double(text.count / 60 + 1), .done("\n\n" + text))]
        let played = Self.play(events, until: 6)
        for (at, delta) in events.compactMap({ timed -> (TimeInterval, String)? in
            if case let .text(delta) = timed.event { (timed.at, delta) } else { nil }
        }) {
            let arrived = events.filter { $0.at <= at }.compactMap { if case let .text(delta) = $0.event { delta } else { nil } }.joined()
            let whole = arrived.trimmingCharacters(in: .whitespacesAndNewlines).count - (arrived.last == " " ? 0 : delta.split(separator: " ").last?.count ?? 0)
            XCTAssertGreaterThanOrEqual(played.frame(at: at + 1.5).markdown.count, whole - 2, "more than 1.5 s behind at \(at)")
        }
        var counts: [Int] = []
        for (_, frame) in played.frames where counts.last != frame.markdown.count { counts.append(frame.markdown.count) }
        XCTAssertGreaterThan(counts.count, 60, "words one by one, not in the model's bursts")
    }

    func testTheSlowestPaceIsOneCharacterPerWordDuration() {
        let played = Self.play([(0.02, .named), (1, .text("One two three four.\n\n"))], until: 2, every: 0.001)
        let reveals = played.lines.count
        XCTAssertEqual(reveals, 3, "Sending, Thinking, Thought for")
        XCTAssertEqual(played.frame(at: 1).markdown, "One")
        XCTAssertEqual(played.frame(at: 1 + 3 * Cockpit.Duration.word - 0.001).markdown, "One", "its turn before the next")
    }

    func testDoneDrainsQuicklyThenSettles() {
        let text = String(repeating: "A long answer arriving all at once. ", count: 20)
        var trace = AskTrace(asked: 0)
        trace.take(.named, at: 0.01)
        trace.take(.text(text), at: 1)
        trace.take(.done(text), at: 1.1)
        let settles = try! XCTUnwrap(trace.settles)
        XCTAssertLessThanOrEqual(settles - 1.1, Self.quiet + 0.01, "drained within the quiet")
        XCTAssertFalse(trace.frame(at: 1.2).settled, "refs and copy wait for the words")
        XCTAssertTrue(trace.frame(at: settles).settled)
        XCTAssertEqual(trace.frame(at: settles).markdown, text)
    }

    func testTheEndMovesNothingAndTheLineNeverChangesAfter() {
        let played = Self.play(Self.typical, until: 16)
        let first = try! XCTUnwrap(played.frames.firstIndex { $0.frame.answering })
        XCTAssertTrue(played.frames[first...].allSatisfy(\.frame.answering), "the copy row's room kept from the first word")
        let settled = try! XCTUnwrap(played.frames.firstIndex { $0.frame.settled })
        let line = played.frames[settled].frame.line
        XCTAssertTrue(played.frames[(first + 1)...].allSatisfy { $0.frame.line == line }, "Thought for from the first word to the end")
        XCTAssertEqual(line, .thought(ms: 10_620))
        XCTAssertEqual(played.frames.last?.frame.markdown, Self.typicalText)
    }

    func testAStopShowsEverythingAtOnce() {
        var trace = AskTrace(asked: 0)
        trace.take(.named, at: 0.01)
        trace.take(.text("Here is everything, day by day. Monday was quiet."), at: 0.5)
        trace.take(.cut(thoughtMs: 480), at: 0.6)
        let frame = trace.frame(at: 0.6)
        XCTAssertTrue(frame.settled)
        XCTAssertEqual(frame.markdown, "Here is everything, day by day. Monday was quiet.")
        XCTAssertEqual(frame.line, .thought(ms: 500), "its first text came at 0.5 s")

        var early = AskTrace(asked: 0)
        early.take(.named, at: 0.01)
        early.take(.cut(thoughtMs: 480), at: 0.6)
        XCTAssertEqual(early.frame(at: 0.6).line, .thought(ms: 480), "no word shown: the home's measure")
    }

    func testAFailureBeforeTheTurnIsNamedHasNoLine() {
        var trace = AskTrace(asked: 0)
        trace.take(.cut(), at: 2)
        XCTAssertNil(trace.frame(at: 2).line)
        XCTAssertTrue(trace.frame(at: 2).settled)
    }

    func testATurnWithNoStepsStillShowsTheLine() {
        let played = Self.play([(0.02, .named), (0.4, .text("Hello.")), (0.6, .done("Hello."))], until: 1)
        XCTAssertEqual(played.frames.last?.frame.line, .thought(ms: 400))
        XCTAssertTrue(played.trace.steps.isEmpty)
    }

    func testDonesTextReplacesWhatStreamed() {
        var kept = AskTrace(asked: 0)
        kept.take(.named, at: 0)
        kept.take(.text("You ran 5 k"), at: 1)
        kept.take(.done("You ran 5 km [r1]."), at: 1.1)
        XCTAssertEqual(kept.frame(at: 10).markdown, "You ran 5 km [r1].")

        var mended = AskTrace(asked: 0)
        mended.take(.named, at: 0)
        mended.take(.text("You met [[Person 1]] at the "), at: 1)
        XCTAssertEqual(mended.frame(at: 1.5).markdown, "You met [[Person 1]] at the")
        mended.take(.done("You met Person A at the market."), at: 2)
        XCTAssertTrue(mended.frame(at: 2).markdown.hasPrefix("You met Person A"), "the words shown so far, mended")
        XCTAssertEqual(mended.frame(at: 10).markdown, "You met Person A at the market.", "done's words, never the streamed ones")
    }

    func testAFollowedTurnEndsOnTheHomesThoughtFor() {
        var trace = AskTrace(asked: 0, followed: true)
        trace.take(.named, at: 60)
        trace.take(.text("You ran 5 km."), at: 60)
        XCTAssertEqual(trace.frame(at: 60.01).line, .thought(ms: 60_000))
        trace.take(.done("You ran 5 km.", thoughtMs: 4_200), at: 60.1)
        XCTAssertEqual(trace.frame(at: 61).line, .thought(ms: 4_200))
    }

    func testATurnReadBackSaysThoughtForItsStoredTime() {
        let read = AskTrace("You did.", steps: [.init("Searched payments for “dinner”")], thoughtMs: 9_400)
        let frame = read.frame(at: 0)
        XCTAssertEqual(frame.line, .thought(ms: 9_400))
        XCTAssertTrue(frame.settled)
        XCTAssertEqual(frame.markdown, "You did.")
        XCTAssertNil(AskTrace("You did.").frame(at: 0).line, "no time kept: no line")
        XCTAssertEqual(read.steps.map(\.id), [1])
    }

    func testAStepSaysTheHomesWordsAFailedOneToo() {
        let played = Self.play(Self.long, until: 17)
        XCTAssertEqual(played.trace.steps.map(\.words), [
            "Searched workouts for “run”", "Searched messages for “run”", "Counted workouts by week", "Couldn’t read the chat with Person B",
        ])
        XCTAssertEqual(played.trace.steps.map(\.failed), [false, false, false, true])
    }

    func testTookSaysTenthsUnderASecondThenSecondsThenMinutes() {
        let edges = [800, 949, 950, 999, 1_000, 9_499, 9_500, 59_499, 59_500, 60_000, 65_000]
        XCTAssertEqual(edges.map(AskSteps.took), ["0.8s", "0.9s", "1s", "1s", "1s", "9s", "10s", "59s", "1m", "1m", "1m 5s"])
    }

    func testTheFadeCountsTheNewestWordsFromTheEnd() {
        let played = Self.play([(0.02, .named), (1, .text("One two three.\n\n"))], until: 2, every: 0.001)
        let fresh = played.frame(at: 1).fresh
        XCTAssertEqual(fresh.map(\.visible), [3])
        XCTAssertEqual(fresh.first?.shown, 0)
        if #available(macOS 15, *) {
            XCTAssertEqual(CiteRenderer.shown(fromEnd: 0, [.init(visible: 3, shown: 0.5)]), 0.75)
            XCTAssertEqual(CiteRenderer.shown(fromEnd: 3, [.init(visible: 3, shown: 0.5)]), 1)
        }
        XCTAssertTrue(played.frame(at: 1 + Cockpit.Duration.fast + 0.5).fresh.isEmpty)
    }

    func testCitationsToldWhileTheAnswerArrivesKeepTheirNumbersAndTheirPhotoAndTheEndMovesNothing() {
        let text = "Dinner was at Synthetic Cafe [r1]. Person A sent a photo of the table [r2].\n\nPerson A booked it again [r3]."
        let chat = "2026-11-13 chat.a"
        let refs = ["r1": AskRef("Chat with Person A", day: "13 Nov", source: chat), "r2": AskRef("Photo of the table", day: "13 Nov", image: true),
                    "r3": AskRef("Chat with Person A", day: "13 Nov", source: chat)]
        let played = Self.play([(0.02, .named)] + Self.search(1, 0.2, 0.9, "messages", "dinner") + Self.bursts(text, from: 1.4) + [(4, .done(text))],
                               until: 8)
        let end = try! XCTUnwrap(played.frames.first { $0.frame.settled }).frame
        XCTAssertEqual(end.markdown, text)
        let settled = Self.seen(Drawn(end.markdown, refs: refs, cut: false))
        XCTAssertEqual(settled.numbers, ["1", "2", "1"], "r3 is the same chat as r1: it folds to r1's number")
        XCTAssertEqual(settled.pictures, ["r2"])
        let running = played.frames.filter { !$0.frame.settled && !$0.frame.markdown.isEmpty }
        XCTAssertFalse(running.isEmpty)
        for (at, frame) in running {
            let now = Self.seen(Drawn(frame.markdown, refs: refs, cut: true))
            XCTAssertEqual(now.numbers, Array(settled.numbers.prefix(now.numbers.count)), "a citation renumbered at \(at): \(frame.markdown)")
            XCTAssertEqual(now.numbers.count, frame.markdown.matches(of: /\[r\d\]/).count, "a citation shown is drawn at once, at \(at)")
            XCTAssertEqual(now.pictures, frame.markdown.contains("[r2]") ? ["r2"] : [], "the photo shows the moment its words do, at \(at)")
        }
        let last = Self.seen(Drawn(end.markdown, refs: refs, cut: true))
        XCTAssertEqual(last.numbers, settled.numbers, "the end moves nothing")
        XCTAssertEqual(last.pictures, settled.pictures, "the end moves nothing")
    }

    func testAVoiceNoteStandsAloneWithItsOwnNumberAndItsBarComesAfterItsParagraphsPhotos() {
        let chat = "2026-11-04 chat.a"
        let note = { (record: String, seconds: Int?) in AskRef.Voice(record: record, seconds: seconds, from: "Person A", mine: false, when: "Tue 4 Nov, 21:40") }
        let refs = ["r1": AskRef("Person A", day: "4 Nov", source: chat, voice: note("record.note-1", 23)),
                    "r2": AskRef("Person A", day: "4 Nov", source: chat, voice: note("record.note-2", 8)),
                    "r3": AskRef("Person A", day: "4 Nov", source: chat), "r4": AskRef("Photo of the table", day: "4 Nov", image: true),
                    "r5": AskRef("Person A", day: "4 Nov", source: chat)]
        let text = "Person A said it twice [r1, r2] and wrote it too [r3], with a photo [r4]. Once more [r5] [r1].\n\nLater that night [r2]."
        let drawn = Self.seen(Drawn(text, refs: refs, cut: false))
        XCTAssertEqual(drawn.numbers, ["1", "2", "3", "4", "3", "1", "2"],
                       "two notes of one chat and day are two numbers, and the chat's messages fold among themselves, never into a note")
        XCTAssertEqual(drawn.items, ["words", "pictures [\"r4\"]", "voices [\"r1\", \"r2\"]", "words"],
                       "the bars under their paragraph, after its photos, in cited order, each once")
        XCTAssertEqual(Self.seen(Drawn("Person A said it [r1]", refs: nil, cut: true)).items, ["words"], "no bar before the refs are known")
    }

    func testOneNoteCitedByTwoRefsDrawsOneBarAndKeepsBothNumbers() {
        let note = AskRef.Voice(record: "record.note-1", seconds: 23, from: "Person A", mine: false, when: "Tue 4 Nov, 21:40")
        let refs = ["r1": AskRef("Person A", day: "4 Nov", source: "2026-11-04 chat.a", voice: note),
                    "r2": AskRef("Person A", day: "4 Nov", voice: note)]
        let drawn = Self.seen(Drawn("Person A said it [r1], and in the chat [r2].\n\nAgain [r2].", refs: refs, cut: false))
        XCTAssertEqual(drawn.numbers, ["1", "2", "2"], "a line and a message of one note are two numbers")
        XCTAssertEqual(drawn.items, ["words", "voices [\"r1\"]", "words"], "one sound, one bar, placed by its first ref")
    }

    func testANoteWithNoSpeakerNamesSomeone() {
        XCTAssertEqual(AskRef.Voice(record: "record.note-1", seconds: 8, from: nil, mine: false, when: "Tue 4 Nov, 21:40").caption,
                       "Someone · Tue 4 Nov, 21:40")
        XCTAssertEqual(AskRef.Voice(record: "record.note-1", seconds: 8, from: nil, mine: true, when: nil).caption, "You")
    }

    private struct Shared: Decodable {
        struct Pace: Decodable {
            let dwell: Double
            let quiet: Double
            let word: Double
        }

        struct Event: Decodable {
            let at: Double
            let named: Bool?
            let began: Int?
            let ended: Int?
            let words: String?
            let said: String?
            let failed: Bool?
            let text: String?
            let done: String?
            let cut: Bool?
            let thought_ms: Int?

            var event: AskTrace.Event {
                if let began { return .began(call: began, words: words ?? "", said: said) }
                if let ended { return .ended(call: ended, words: words ?? "", failed: failed ?? false) }
                if let text { return .text(text) }
                if let done { return .done(done, thoughtMs: thought_ms) }
                if cut == true { return .cut(thoughtMs: thought_ms) }
                return .named
            }
        }

        struct Frame: Decodable {
            let at: Double
            let line: String
            let shown: String
            let settled: Bool
        }

        struct Case: Decodable {
            let name: String
            let followed: Bool?
            let events: [Event]
            let frames: [Frame]
        }

        let pace: Pace
        let cases: [Case]
    }

    func testTheTimelinesTheWebSharesDrawTheSameFrames() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        let shared = try JSONDecoder().decode(Shared.self, from: Data(contentsOf: root.appendingPathComponent("ask-trace.json")))
        XCTAssertEqual([shared.pace.dwell / 1000, shared.pace.quiet / 1000, shared.pace.word / 1000],
                       [Cockpit.Duration.dwell, Cockpit.Duration.quiet, Cockpit.Duration.word], "the timelines' pace is the tokens'")
        for each in shared.cases {
            var trace = AskTrace(asked: 0, followed: each.followed ?? false)
            var pending = each.events[...]
            for frame in each.frames {
                while let next = pending.first, next.at <= frame.at {
                    trace.take(next.event, at: next.at / 1000)
                    pending = pending.dropFirst()
                }
                let drawn = trace.frame(at: frame.at / 1000)
                XCTAssertEqual(drawn.line.map(AskSteps.words) ?? "", frame.line, "\(each.name) at \(frame.at)")
                XCTAssertEqual(drawn.markdown, frame.shown, "\(each.name) at \(frame.at)")
                XCTAssertEqual(drawn.settled, frame.settled, "\(each.name) at \(frame.at)")
            }
        }
    }

    private static func seen(_ drawn: Drawn) -> (numbers: [String], pictures: [String], items: [String]) {
        var numbers: [String] = []
        var pictures: [String] = []
        var items: [String] = []
        for item in drawn.items {
            switch item {
            case let .block(block):
                switch block.kind {
                case let .text(runs), let .heading(runs):
                    for case let .cite(_, number, _) in runs { numbers.append(number) }
                case .code, .rule, .table: break
                }
                items.append("words")
            case let .pictures(handles):
                pictures += handles
                items.append("pictures \(handles)")
            case let .voices(handles):
                items.append("voices \(handles)")
            }
        }
        return (numbers, pictures, items)
    }

    private static func unclosed(_ markdown: String) -> String {
        var text = markdown
        while text.hasSuffix("*") { text.removeLast() }
        return text
    }
}

private extension Double {
    func rounded(toPlaces places: Int) -> Double {
        let scale = pow(10, Double(places))
        return (self * scale).rounded() / scale
    }
}
