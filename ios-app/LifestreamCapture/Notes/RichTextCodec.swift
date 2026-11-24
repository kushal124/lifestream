import Foundation
import LifestreamCaptureCore
import UIKit

enum RichTextCodec {
    static func encode(_ attributed: NSAttributedString) throws -> Data {
        do {
            return try NSKeyedArchiver.archivedData(
                withRootObject: attributed,
                requiringSecureCoding: true
            )
        } catch {
            throw NotesError.richText(
                "Notes could not archive rich text: \(error.localizedDescription)"
            )
        }
    }

    static func decode(_ data: Data) throws -> NSAttributedString {
        if data.isEmpty {
            return NSAttributedString(string: "", attributes: NoteFormatting.bodyAttributes())
        }
        do {
            guard
                let attributed = try NSKeyedUnarchiver.unarchivedObject(
                    ofClass: NSAttributedString.self,
                    from: data
                )
            else {
                throw NotesError.richText("Notes rich text archive did not contain attributed text.")
            }
            return NoteFormatting.restoringDynamicColors(
                in: NoteFormatting.restoringTextStyles(
                    in: NoteFormatting.restoringChecklists(in: attributed)
                )
            )
        } catch let error as NotesError {
            throw error
        } catch {
            throw NotesError.richText(
                "Notes could not read rich text: \(error.localizedDescription)"
            )
        }
    }

    static func plainText(from attributed: NSAttributedString) -> String {
        attributed.string
    }

    static func inferredTitle(from plainText: String) -> String {
        NoteSearchIndex.firstMeaningfulLine(in: plainText) ?? ""
    }

    static func inferredSnippet(from plainText: String) -> String {
        let lines = plainText.split(whereSeparator: \.isNewline)
            .map { NoteSearchIndex.strippedMarker(String($0)) }
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        guard lines.count > 1 else { return "" }
        return lines.dropFirst().joined(separator: " · ")
    }
}

enum NoteSearchIndex {
    static func make(title: String, plainText: String, attachmentNames: [String]) -> String {
        ([title, plainText] + attachmentNames)
            .joined(separator: "\n")
            .localizedLowercase
    }

    static func plainText(from richTextData: Data) -> String {
        (try? RichTextCodec.decode(richTextData).string) ?? ""
    }

    static func firstMeaningfulLine(in plainText: String) -> String? {
        for line in plainText.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            let cleaned = strippedMarker(String(line))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !cleaned.isEmpty { return cleaned }
        }
        return nil
    }

    static func strippedMarker(_ line: String) -> String {
        var text = line
        if text.hasPrefix("☐ ") || text.hasPrefix("☑ ") {
            text.removeFirst(2)
        }
        return text
    }

    static func matches(query: String, searchText: String) -> Bool {
        let tokens = query.lowercased().split { $0.isWhitespace || $0.isNewline }
            .map(String.init)
            .filter { !$0.isEmpty }
        guard !tokens.isEmpty else { return false }
        return tokens.allSatisfy { searchText.contains($0) }
    }
}

enum NotePreviewFormatting {
    static func listDate(_ date: Date, now: Date, grouped: Bool = false, calendar: Calendar = .current) -> String {
        Words.rowWhen(date, zone: calendar.timeZone, now: now, grouped: grouped)
    }

    static func groupTitle(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        Words.groupWhen(date, zone: calendar.timeZone, now: now)
    }

    static func editorTimestamp(_ date: Date) -> String {
        Words.longDate(date) + Words.dot + Words.clock(date)
    }

    static func remainingRetention(
        deletedAt: Date,
        now: Date,
        lifetime: TimeInterval = NotesRetention.deletedNoteLifetime
    ) -> String {
        let remaining = deletedAt.addingTimeInterval(lifetime).timeIntervalSince(now)
        let days = Int(ceil(remaining / 86_400))
        return days <= 1 ? "Last day" : Words.count(days, "day") + " left"
    }
}
