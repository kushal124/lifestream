import UIKit
import XCTest

@testable import Lifestream

final class NotesRichTextTests: XCTestCase {
    @MainActor
    func testCaretFormattingChangesFutureTypingWithoutInsertingPlaceholderText() {
        let view = UITextView()
        let session = NoteEditorSession(
            noteID: UUID(), createdAt: Date(), attributed: NSAttributedString(string: ""))
        session.bind(textView: view)
        view.typingAttributes = NoteFormatting.bodyAttributes()
        session.applyInline { NoteFormatting.toggleTrait(.traitBold, in: $0, range: $1) }
        XCTAssertTrue(session.isTraitActive(.traitBold))
        XCTAssertEqual(view.text, "")
        view.insertText("Bold")
        XCTAssertTrue(
            (view.textStorage.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)?.fontDescriptor
                .symbolicTraits.contains(.traitBold) == true)
        view.selectedRange = NSRange(location: view.textStorage.length, length: 0)
        session.applyInline { NoteFormatting.toggleUnderline(in: $0, range: $1) }
        XCTAssertTrue(session.isAttributeActive(.underlineStyle))
    }

    @MainActor
    func testEmptyParagraphStyleUpdatesTypingAttributes() {
        let view = UITextView()
        let session = NoteEditorSession(
            noteID: UUID(), createdAt: Date(), attributed: NSAttributedString(string: ""))
        session.bind(textView: view)
        session.applyParagraph { NoteFormatting.applyBlockStyle(.monospaced, to: $0, range: $1) }
        XCTAssertTrue(
            (view.typingAttributes[.font] as? UIFont)?.fontName.lowercased().contains("mono") == true)
        session.applyParagraph { NoteFormatting.indent(by: 1, in: $0, range: $1) }
        XCTAssertEqual(
            (view.typingAttributes[.paragraphStyle] as? NSParagraphStyle)?.headIndent,
            NoteFormatting.indentStep)
        XCTAssertEqual(view.text, "")
    }

    @MainActor
    func testListReturnContinuesAndEmptyReturnExits() {
        for kind in [NoteFormatting.ListKind.checklist, .bulleted, .numbered] {
            let view = UITextView()
            let session = NoteEditorSession(
                noteID: UUID(), createdAt: Date(),
                attributed: NSAttributedString(string: "Milk", attributes: NoteFormatting.bodyAttributes()))
            session.bind(textView: view)
            view.selectedRange = NSRange(location: 4, length: 0)
            session.applyList(kind)
            XCTAssertTrue(session.insertListNewline(in: view.selectedRange))
            if kind == .checklist {
                XCTAssertEqual(view.text, "☐ Milk\n☐ ")
            } else {
                XCTAssertEqual(view.text, "Milk\n")
                XCTAssertFalse(
                    (view.typingAttributes[.paragraphStyle] as? NSParagraphStyle)?.textLists.isEmpty ?? true)
            }
            XCTAssertTrue(session.insertListNewline(in: view.selectedRange))
            XCTAssertEqual(view.text, kind == .checklist ? "☐ Milk\n" : "Milk\n")
            XCTAssertTrue(
                (view.typingAttributes[.paragraphStyle] as? NSParagraphStyle)?.textLists.isEmpty == true)
            XCTAssertNil(view.typingAttributes[NoteFormatting.checklistAttribute])
        }
    }

    @MainActor
    func testLinkUsesCaretAndPreservesFont() {
        let view = UITextView()
        let session = NoteEditorSession(
            noteID: UUID(), createdAt: Date(),
            attributed: NSAttributedString(string: "AB", attributes: NoteFormatting.bodyAttributes()))
        session.bind(textView: view)
        view.selectedRange = NSRange(location: 1, length: 0)
        view.typingAttributes = NoteFormatting.bodyAttributes()
        session.insertLink(URL(string: "https://example.com")!)
        XCTAssertEqual(view.text, "Ahttps://example.comB")
        XCTAssertNotNil(view.textStorage.attribute(.font, at: 1, effectiveRange: nil))
        XCTAssertNotNil(view.textStorage.attribute(.link, at: 1, effectiveRange: nil))
        XCTAssertEqual(view.selectedRange.location, 20)
        XCTAssertTrue(session.isDirty)
    }

    @MainActor
    func testFormattingUndoAndRedoRestoreTextAndAttributes() {
        let view = UndoableNotesTestView()
        let session = NoteEditorSession(
            noteID: UUID(), createdAt: Date(),
            attributed: NSAttributedString(string: "Milk", attributes: NoteFormatting.bodyAttributes()))
        session.bind(textView: view)
        view.selectedRange = NSRange(location: 0, length: 4)
        view.history.beginUndoGrouping()
        session.applyList(.checklist)
        view.history.endUndoGrouping()
        XCTAssertEqual(view.text, "☐ Milk")
        view.history.undo()
        XCTAssertEqual(view.text, "Milk")
        view.history.redo()
        XCTAssertEqual(view.text, "☐ Milk")
        XCTAssertTrue(session.isDirty)
    }

    @MainActor
    func testReturnOnTitleParagraphGivesTheNextWordBodyFont() {
        let view = UITextView()
        let session = NoteEditorSession(
            noteID: UUID(), createdAt: Date(),
            attributed: NSAttributedString(
                string: "Tokyo trip", attributes: NoteFormatting.attributes(for: .title)))
        session.bind(textView: view)
        view.selectedRange = NSRange(location: 10, length: 0)
        view.typingAttributes = NoteFormatting.attributes(for: .title)
        let coordinator = NoteTextView.Coordinator(
            session: session, onChange: {}, onChecklistToggle: { _ in })

        if coordinator.textView(view, shouldChangeTextIn: view.selectedRange, replacementText: "\n") {
            view.insertText("\n")
        }
        view.insertText("Book")

        XCTAssertEqual(view.text, "Tokyo trip\nBook")
        let bookFont = view.textStorage.attribute(.font, at: 11, effectiveRange: nil) as? UIFont
        XCTAssertEqual(bookFont?.pointSize, NoteFormatting.font(for: .body).pointSize)
        XCTAssertFalse(bookFont?.fontDescriptor.symbolicTraits.contains(.traitBold) ?? true)
        let titleFont = view.textStorage.attribute(.font, at: 0, effectiveRange: nil) as? UIFont
        XCTAssertEqual(titleFont?.pointSize, NoteFormatting.font(for: .title).pointSize)
        XCTAssertEqual(
            (view.typingAttributes[.font] as? UIFont)?.pointSize,
            NoteFormatting.font(for: .body).pointSize)
        XCTAssertTrue(session.isDirty)
    }

    @MainActor
    func testChecklistAccessibilityActionsNameEachItemAndState() {
        let view = UITextView()
        let session = NoteEditorSession(
            noteID: UUID(), createdAt: Date(),
            attributed: NSAttributedString(
                string: "☐ Milk\n☑ Bread", attributes: NoteFormatting.bodyAttributes()))
        session.bind(textView: view)
        let coordinator = NoteTextView.Coordinator(
            session: session, onChange: {}, onChecklistToggle: { _ in })
        coordinator.updateChecklistActions(view)
        XCTAssertEqual(view.accessibilityCustomActions?.map(\.name), ["Check Milk", "Uncheck Bread"])
    }

    @MainActor
    func testEditorDrawsCheckboxesWhileTheModelKeepsGlyphs() {
        let view = NotesEditorTextView()
        let session = NoteEditorSession(
            noteID: UUID(), createdAt: Date(),
            attributed: NSAttributedString(string: "Milk", attributes: NoteFormatting.bodyAttributes()))
        session.drawsCheckboxes = true
        session.bind(textView: view)
        view.selectedRange = NSRange(location: 4, length: 0)
        session.applyList(.checklist)

        XCTAssertEqual(view.text, "\u{FFFC} Milk")
        XCTAssertEqual(session.attributed.string, "☐ Milk")
        XCTAssertEqual(view.accessibilityValue, "☐ Milk")
        let shown = view.textStorage.attribute(.attachment, at: 0, effectiveRange: nil)
        XCTAssertEqual((shown as? NoteChecklistAttachment)?.isChecked, false)
        XCTAssertNil(session.attributed.attribute(.attachment, at: 0, effectiveRange: nil))
        XCTAssertTrue(session.isChecklistSelection)

        session.applyToStorage { storage, _ in
            NoteFormatting.toggleChecklistItem(in: storage, at: 0)
        }
        XCTAssertEqual(session.attributed.string, "☑ Milk")
        XCTAssertEqual(
            (view.textStorage.attribute(.attachment, at: 0, effectiveRange: nil) as? NoteChecklistAttachment)?
                .isChecked, true)

        view.selectedRange = NSRange(location: 6, length: 0)
        XCTAssertTrue(session.insertListNewline(in: view.selectedRange))
        XCTAssertEqual(view.text, "\u{FFFC} Milk\n\u{FFFC} ")
        XCTAssertEqual(session.attributed.string, "☑ Milk\n☐ ")
        XCTAssertNil(view.typingAttributes[.attachment])

        let decoded = try? RichTextCodec.decode(try RichTextCodec.encode(session.attributed))
        XCTAssertEqual(decoded?.string, "☑ Milk\n☐ ")
    }
}

@MainActor
private final class UndoableNotesTestView: UITextView {
    let history = UndoManager()
    override var undoManager: UndoManager? { history }
}

extension NotesRichTextTests {
    @MainActor
    func testOptimizationChecklistConversion() throws {
        guard ProcessInfo.processInfo.environment["OPTIMIZATION_BENCHMARK"] == "1" else {
            throw XCTSkip("Explicit rich checklist workload")
        }
        var rows: [[String: Any]] = []
        for count in [10_000, 100_000] {
            let paragraph = "☐ synthetic é 🟢 checklist paragraph with formatting\n"
            let text = String(String(repeating: paragraph, count: count / paragraph.count + 1).prefix(count))
            let model = NSAttributedString(string: text, attributes: NoteFormatting.bodyAttributes())
            let display = NoteChecklistGlyphs.displaying(model, traits: UITraitCollection())
            var samples: [Double] = []
            for index in 0...30 {
                let start = CACurrentMediaTime()
                let restored = NoteChecklistGlyphs.restoringGlyphs(display)
                let elapsed = CACurrentMediaTime() - start
                XCTAssertEqual(restored.string, model.string)
                if index > 0 { samples.append(elapsed) }
            }
            rows.append(["utf16_length": model.length, "seconds": samples])
        }
        let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: rows, options: [.prettyPrinted, .sortedKeys]),
            uniformTypeIdentifier: "public.json")
        attachment.name = "optimization-checklists.json"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

final class NoteDateWordsTests: XCTestCase {
    private let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    private func at(_ text: String) -> Date {
        ISO8601DateFormatter().date(from: text)!
    }

    func testANoteDatedAfterTodayIsComingUpNotToday() {
        let now = at("2026-11-16T10:00:00Z")
        XCTAssertEqual(NotePreviewFormatting.groupTitle(at("2026-11-20T09:00:00Z"), now: now, calendar: utc), "Coming up")
    }

    func testARowUnderYesterdaySaysItsClockOnlyWhenGrouped() {
        let now = at("2026-11-16T10:00:00Z")
        let yesterday = at("2026-11-15T21:27:00Z")
        XCTAssertEqual(NotePreviewFormatting.groupTitle(yesterday, now: now, calendar: utc), "Yesterday")
        XCTAssertEqual(NotePreviewFormatting.listDate(yesterday, now: now, grouped: true, calendar: utc), "21:27")
        XCTAssertEqual(NotePreviewFormatting.listDate(yesterday, now: now, calendar: utc), "Yesterday")
    }
}
