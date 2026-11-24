import Foundation
import XCTest
@testable import Cockpit

final class SeenTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Span: Decodable {
            let start: Int
            let end: Int
            let placeholder: String?
            let added: String?

            var seen: AskSeen.Span { placeholder.map { .placeholder(start, end, $0) } ?? .added(start, added ?? "") }
        }

        struct Seen: Decodable {
            let asked: [Span]
            let spoken: String?
            let answered: [Span]
            let photos: [String?]?

            var record: AskSeen { AskSeen(asked: asked.map(\.seen), spoken: spoken, answered: answered.map(\.seen), photos: photos) }
        }

        struct Model: Decodable {
            let asked: String
            let answered: String
        }

        struct Ref: Decodable {
            let asked: String
        }

        struct Turn: Decodable {
            let name: String
            let words: String
            let photos: Int?
            let answer: String
            let end: String
            let refs: [String: Ref]?
            let seen: Seen
            let model: Model?
            let details: [String]?
            let eye: Bool
            let why: String?

            var ended: AskSeen.End {
                switch end {
                case "done": .done
                case "stopped": .stopped
                case "failed": .failed
                default: .running
                }
            }
        }

        struct Fill: Decodable {
            let to: Double
            let fromMs: Int

            enum CodingKeys: String, CodingKey {
                case to
                case fromMs = "from_ms"
            }
        }

        struct Frame: Decodable {
            let from: String
            let to: String
            let index: Int
            let atMs: [Int]
            let locked: [Int]
            let fill: Fill

            enum CodingKeys: String, CodingKey {
                case from, to, index, locked, fill
                case atMs = "at_ms"
            }
        }

        let cipher: String
        let turns: [Turn]
        let frames: [Frame]
    }

    private static func fixture() throws -> Fixture {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: root.appendingPathComponent("privacy-view.json")))
    }

    func testTheAlphabetIsTheSharedCipher() throws {
        XCTAssertEqual(String(SeenClock.cipher), try Self.fixture().cipher)
    }

    func testEveryCaseOfTheFixtureHasItsEyeAndDrawsTheModelsTextDetailByDetail() throws {
        for turn in try Self.fixture().turns {
            let refs = (turn.refs ?? [:]).mapValues { AskRef($0.asked, day: nil) }
            let seen = AskSeen.eye(turn.seen.record, words: turn.words, voice: turn.seen.spoken != nil, photos: turn.photos ?? 0,
                                   answer: turn.answer, end: turn.ended)
            let drawn = Drawn(turn.answer, refs: refs, cut: turn.ended != .done, seen: seen?.answered)
            XCTAssertEqual(seen != nil && drawn.seeing, turn.eye, "\(turn.name): \(turn.why ?? "it has an eye")")
            guard turn.eye, let seen, let model = turn.model, let details = turn.details else { continue }
            let shown = Self.shown(drawn, after: seen.asked.count, on: true)
            XCTAssertEqual(Self.asked(turn.words, seen.asked), model.asked, turn.name)
            XCTAssertEqual(Self.read(drawn, shown), model.answered, turn.name)
            XCTAssertEqual(seen.asked.map(\.said) + Self.details(drawn), details, "\(turn.name): one detail each, in reading order")
            XCTAssertEqual(Self.read(drawn, Self.shown(drawn, after: seen.asked.count, on: false)), Self.read(Drawn(turn.answer, refs: refs), nil),
                           "\(turn.name): the person's view is as with no record")
        }
    }

    func testEachFrameLocksAndFillsAsTheWebDoes() throws {
        for frame in try Self.fixture().frames {
            let clock = SeenClock(at: 0, on: frame.fill.to == 1)
            let start = frame.index * SeenClock.stagger
            for (at, locked) in zip(frame.atMs, frame.locked) {
                let state = clock.state(at - start, from: frame.from.count, to: frame.to.count)
                XCTAssertEqual(state.locked, locked, "\(frame.from) → \(frame.to) at \(at) ms")
            }
            let fading = clock.state(frame.fill.fromMs - start, from: frame.from.count, to: frame.to.count)
            XCTAssertEqual(fading.fill, 1 - frame.fill.to, accuracy: 0.001, "the fill starts its fade at \(frame.fill.fromMs) ms")
            let faded = clock.state(frame.fill.fromMs - start + SeenClock.glide, from: frame.from.count, to: frame.to.count)
            XCTAssertEqual(faded.fill, frame.fill.to, accuracy: 0.001, "the fill ends its fade a base duration later")
            let ended = clock.look(frame.index, from: frame.from.count, to: frame.to.count,
                                   at: Double(start + SeenClock.lasts) / 1000)
            XCTAssertEqual(ended, clock.on ? .model : .person)
        }
    }

    func testOffsetsAreUTF16AroundAnEmoji() {
        let words = "😀 Person A, then 👍🏽 Person B"
        let spans = Self.placed(words, [("Person A", "[[Person 1]]"), ("Person B", "[[Person 2]]")])
        XCTAssertEqual(spans.first?.start, 3, "the emoji is two UTF-16 units and the space one")
        XCTAssertEqual(Self.asked(words, spans), "😀 [[Person 1]], then 👍🏽 [[Person 2]]")
        let drawn = Drawn(words, refs: nil, seen: spans)
        XCTAssertEqual(Self.read(drawn, Self.shown(drawn, after: 0, on: true)), "😀 [[Person 1]], then 👍🏽 [[Person 2]]")
    }

    func testASpanThatDoesNotFitItsTextIsNoEye() {
        XCTAssertFalse(AskSeen.fits("Person A", [.placeholder(0, 9, "[[Person 1]]")]))
        XCTAssertFalse(AskSeen.fits("Person A and B", [.placeholder(4, 8, "[[x]]"), .placeholder(0, 2, "[[y]]")]))
        XCTAssertFalse(AskSeen.fits("Person A", [.added(0, "a"), .placeholder(0, 0, "[[x]]"), .placeholder(1, 0, "[[y]]")]))
        XCTAssertFalse(Drawn("Person A", refs: nil, seen: [.placeholder(0, 9, "[[Person 1]]")]).seeing)
        XCTAssertFalse(Drawn("Person A", refs: nil, seen: [.placeholder(3, 3, "[[Person 1]]")]).seeing, "a span of an answer with no words draws nothing")
    }

    func testSpansThroughTheMarkdownDrawTheirDetailOrThereIsNoEye() {
        let cases: [(markdown: String, hidden: [(String, String)], eye: Bool, model: String)] = [
            ("Dinner with **Person A Example** on Friday.", [("Person A Example", "[[Person 1]]")], true,
             "Dinner with [[Person 1]] on Friday."),
            ("Mail [Person A](mailto:person-a@example.com) now.", [("Person A", "[[Person 1]]"), ("person-a@example.com", "[[Email 1]]")], true,
             "Mail [[Person 1]] now."),
            ("Her number is `+1 555 0100`.", [("+1 555 0100", "[[Phone 1]]")], true, "Her number is [[Phone 1]]."),
            ("- Person A\n- Person B", [("Person A", "[[Person 1]]"), ("Person B", "[[Person 2]]")], true, "[[Person 1]]\n[[Person 2]]"),
            ("| Who |\n|---|\n| Person A |", [("Person A", "[[Person 1]]")], true, "Who\n[[Person 1]]"),
            ("First.\n\n\nPerson A came.", [("Person A", "[[Person 1]]")], true, "First.\n[[Person 1]] came."),
            ("Call **+1 555 0100**, then *Person A*.", [("+1 555 0100", "[[Phone 1]]"), ("Person A", "[[Person 1]]")], true,
             "Call [[Phone 1]], then [[Person 1]]."),
            ("😀 **Person A** came [r1].\n\nSources: [r1]", [("Person A", "[[Person 1]]")], true, "😀 [[Person 1]] came [r1]."),
            ("Person A <person-a@example.com> wrote.", [("Person A", "[[Person 1]]"), ("person-a@example.com", "[[Email 1]]")], true,
             "[[Person 1]] <[[Email 1]]> wrote."),
            ("See <https://example.com/Person-A/Person-B> now.", [("Person-A", "[[Person 1]]"), ("Person-B", "[[Person 2]]")], true,
             "See <https://example.com/[[Person 1]]/[[Person 2]]> now."),
            ("x < Person A and y > 2", [("Person A", "[[Person 1]]")], true, "x < [[Person 1]] and y > 2"),
            ("Call a**+1 555 0100** now.", [("+1 555 0100", "[[Phone 1]]")], false, ""),
        ]
        for (markdown, hidden, eye, model) in cases {
            let drawn = Drawn(markdown, refs: nil, seen: Self.placed(markdown, hidden))
            XCTAssertEqual(drawn.seeing, eye, markdown)
            guard eye else { continue }
            XCTAssertEqual(Self.read(drawn, Self.shown(drawn, after: 0, on: true)), model, markdown)
            XCTAssertEqual(Self.read(drawn, Self.shown(drawn, after: 0, on: false)), Self.read(Drawn(markdown, refs: nil), nil),
                           "the person's view of \(markdown) is as with no record")
        }
    }

    func testSpansSharingAnAutolinkAreOneDetailTheAddressAsDrawn() {
        let markdown = "See <https://example.com/Person-A/Person-B> now."
        let drawn = Drawn(markdown, refs: nil, seen: Self.placed(markdown, [("Person-A", "[[Person 1]]"), ("Person-B", "[[Person 2]]")]))
        XCTAssertEqual(Self.details(drawn), ["<https://example.com/[[Person 1]]/[[Person 2]]>"])
        XCTAssertEqual(drawn.person[.span(0)], "https://example.com/Person-A/Person-B")
    }

    func testAFencedBlockSwapsWholeToItsModelText() {
        let markdown = "Write:\n\n```\nto: person-a@example.com\n```"
        let drawn = Drawn(markdown, refs: nil, seen: Self.placed(markdown, [("person-a@example.com", "[[Email 1]]")]))
        XCTAssertTrue(drawn.seeing, "a span in a fenced block is drawn there")
        let shown = Self.shown(drawn, after: 0, on: true)
        let code = drawn.items.compactMap { item -> AttributedString? in
            if case let .block(block) = item, case let .code(code) = block.kind { code } else { nil }
        }.first
        XCTAssertEqual(code.map { String($0.characters) }, "to: person-a@example.com")
        XCTAssertEqual(code.map { shown.code($0, on: true) }, "to: [[Email 1]]")
        XCTAssertEqual(code.map { shown.code($0, on: false) }, "to: person-a@example.com")
    }

    func testACapsuleReadsAsTheModelWroteItInReadingOrder() {
        let markdown = "Person A came [r1][r2], then left [r3]."
        let drawn = Drawn(markdown, refs: nil, seen: Self.placed(markdown, [("Person A", "[[Person 1]]")]))
        XCTAssertEqual(drawn.model[.cite(0)], "[r1][r2]")
        XCTAssertEqual(drawn.person[.cite(0)], "1")
        XCTAssertEqual(drawn.model[.cite(1)], "[r3]")
        XCTAssertEqual(drawn.order[.span(0)], 0)
        XCTAssertEqual(drawn.order[.cite(0)], 1)
        XCTAssertEqual(drawn.order[.cite(1)], 2)
        XCTAssertFalse(Drawn.copied(markdown).contains("\u{E100}"), "Copy holds no marker")
    }

    func testAHandleThatResolvesToNothingDrawsNothingForThePersonAndReadsAsWrittenForTheModel() {
        let markdown = "Person A left [r9]."
        let refs = ["r1": AskRef("A row", day: nil)]
        let drawn = Drawn(markdown, refs: refs, seen: Self.placed(markdown, [("Person A", "[[Person 1]]")]))
        XCTAssertTrue(drawn.seeing)
        XCTAssertEqual(drawn.person[.cite(0)], "", "it grows from nothing")
        XCTAssertEqual(Self.read(drawn, Self.shown(drawn, after: 0, on: true)), "[[Person 1]] left [r9].")
        XCTAssertEqual(Self.read(Drawn(markdown, refs: refs), nil), "Person A left .", "the person's view draws it as before: nothing")
    }

    private static func placed(_ text: String, _ pairs: [(String, String)]) -> [AskSeen.Span] {
        var from = text.startIndex
        return pairs.compactMap { words, said in
            guard let range = text.range(of: words, range: from..<text.endIndex) else { return nil }
            from = range.upperBound
            return .placeholder(text.utf16.distance(from: text.startIndex, to: range.lowerBound),
                                text.utf16.distance(from: text.startIndex, to: range.upperBound), said)
        }
    }

    private static func shown(_ drawn: Drawn, after: Int, on: Bool) -> Shown {
        Shown(showing: SeenShowing(now: 0, on: on, clock: nil, size: 15), after: after, drawn: drawn)
    }

    private static func asked(_ words: String, _ spans: [AskSeen.Span]) -> String {
        AskSeen.pieces(words, spans).map { piece in piece.span.map { spans[$0].said } ?? piece.words }.joined()
    }

    private static func details(_ drawn: Drawn) -> [String] {
        drawn.order.sorted { $0.value < $1.value }.compactMap { drawn.model[$0.key] }
    }

    private static func read(_ drawn: Drawn, _ shown: Shown?) -> String {
        func line(_ runs: [Drawn.Run]) -> String {
            Drawn.pieces(runs, shown: shown, closeUp: false).map { piece in
                switch piece {
                case let .words(words, _, _): String(words.characters)
                case let .detail(detail, look): look == .person ? drawn.person[detail] ?? "" : drawn.model[detail] ?? ""
                case let .cite(_, number): "[\(number)]"
                }
            }.joined()
        }
        var lines: [String] = []
        for case let .block(block) in drawn.items {
            switch block.kind {
            case let .text(runs), let .heading(runs): lines.append(line(runs))
            case let .table(rows): lines += rows.map { $0.cells.map(line).joined(separator: " | ") }
            case let .code(code): lines.append(shown?.code(code, on: shown?.showing.on == true) ?? String(code.characters))
            case .rule: lines.append("---")
            }
        }
        return lines.joined(separator: "\n")
    }
}
