import Cockpit
import SwiftUI
import UIKit

enum NoteFormatting {
    enum BlockStyle: String, CaseIterable, Identifiable {
        case title
        case heading
        case subheading
        case body
        case monospaced

        var id: String { rawValue }

        var title: String {
            switch self {
            case .title: "Title"
            case .heading: "Heading"
            case .subheading: "Subheading"
            case .body: "Body"
            case .monospaced: "Monospaced"
            }
        }
    }

    enum ListKind: String, CaseIterable {
        case none
        case bulleted
        case dashed
        case numbered
        case checklist
    }

    static let checklistAttribute = NSAttributedString.Key("org.lifestreamprotocol.notes.checklist")

    static let textColor = UIColor(Cockpit.Color.text)
    static let doneColor = UIColor(Cockpit.Color.textSecondary)
    static let highlightColor = UIColor(Cockpit.Color.data4)
    static let pageColor = UIColor(Cockpit.Color.surface)
    static let indentStep: CGFloat = 24

    static func bodyAttributes() -> [NSAttributedString.Key: Any] {
        attributes(for: .body)
    }

    static func attributes(for style: BlockStyle) -> [NSAttributedString.Key: Any] {
        [
            .font: font(for: style),
            .foregroundColor: textColor,
            .paragraphStyle: paragraphStyle(indent: 0, list: nil),
        ]
    }

    static func font(for style: BlockStyle, compatibleWith traits: UITraitCollection? = nil) -> UIFont {
        switch style {
        case .title:
            styledFont(.title1, weight: .bold, traits: traits)
        case .heading:
            styledFont(.title2, weight: .bold, traits: traits)
        case .subheading:
            styledFont(.title3, weight: .semibold, traits: traits)
        case .body:
            UIFont.preferredFont(forTextStyle: .body, compatibleWith: traits)
        case .monospaced:
            UIFont.monospacedSystemFont(
                ofSize: UIFont.preferredFont(forTextStyle: .body, compatibleWith: traits).pointSize,
                weight: .regular
            )
        }
    }

    static func blockStyle(of font: UIFont) -> BlockStyle? {
        if font.fontDescriptor.symbolicTraits.contains(.traitMonoSpace)
            || font.fontName.localizedCaseInsensitiveContains("mono")
        {
            return .monospaced
        }
        if let usage = font.fontDescriptor.object(forKey: .textStyle) as? String {
            let baseUsage = usage.replacingOccurrences(of: "Emphasized", with: "")
                .replacingOccurrences(of: "Italic", with: "")
            switch UIFont.TextStyle(rawValue: baseUsage) {
            case .title1: return .title
            case .title2: return .heading
            case .title3: return .subheading
            case .body: return .body
            default: return nil
            }
        }
        let large = UITraitCollection(preferredContentSizeCategory: .large)
        for style in [BlockStyle.title, .heading, .subheading, .body]
        where abs(self.font(for: style, compatibleWith: large).pointSize - font.pointSize) < 0.5 {
            return style
        }
        return nil
    }

    static func restoringTextStyles(in attributed: NSAttributedString) -> NSAttributedString {
        let storage = NSMutableAttributedString(attributedString: attributed)
        guard storage.length > 0 else { return storage }
        storage.enumerateAttribute(.font, in: NSRange(location: 0, length: storage.length)) {
            value, range, _ in
            guard let archived = value as? UIFont, let style = blockStyle(of: archived) else { return }
            let base = font(for: style)
            var traits = base.fontDescriptor.symbolicTraits
            for trait in [UIFontDescriptor.SymbolicTraits.traitBold, .traitItalic] {
                if archived.fontDescriptor.symbolicTraits.contains(trait) {
                    traits.insert(trait)
                } else {
                    traits.remove(trait)
                }
            }
            let descriptor = base.fontDescriptor.withSymbolicTraits(traits) ?? base.fontDescriptor
            storage.addAttribute(.font, value: UIFont(descriptor: descriptor, size: base.pointSize), range: range)
        }
        return storage
    }

    static func applyBlockStyle(
        _ style: BlockStyle,
        to storage: NSMutableAttributedString,
        range: NSRange
    ) {
        let paragraphRange = storage.mutableString.paragraphRange(for: range)
        guard paragraphRange.length > 0 else { return }
        storage.addAttribute(.font, value: font(for: style), range: paragraphRange)
        if style == .monospaced {
            var indent: CGFloat = 0
            if let current = storage.attribute(
                .paragraphStyle, at: paragraphRange.location, effectiveRange: nil
            ) as? NSParagraphStyle {
                indent = current.headIndent
            }
            storage.addAttribute(
                .paragraphStyle,
                value: paragraphStyle(indent: indent, list: nil),
                range: paragraphRange
            )
        }
    }

    static func toggleTrait(
        _ trait: UIFontDescriptor.SymbolicTraits,
        in storage: NSMutableAttributedString,
        range: NSRange
    ) {
        guard range.length > 0 else { return }
        var allHaveTrait = true
        storage.enumerateAttribute(.font, in: range) { value, _, _ in
            let font = (value as? UIFont) ?? font(for: .body)
            if !font.fontDescriptor.symbolicTraits.contains(trait) { allHaveTrait = false }
        }
        storage.enumerateAttribute(.font, in: range) { value, subrange, _ in
            let current = (value as? UIFont) ?? font(for: .body)
            var traits = current.fontDescriptor.symbolicTraits
            if allHaveTrait {
                traits.remove(trait)
            } else {
                traits.insert(trait)
            }
            guard let descriptor = current.fontDescriptor.withSymbolicTraits(traits) else { return }
            storage.addAttribute(
                .font,
                value: UIFont(descriptor: descriptor, size: current.pointSize),
                range: subrange
            )
        }
    }

    static func toggleUnderline(in storage: NSMutableAttributedString, range: NSRange) {
        toggleStyleAttribute(
            .underlineStyle,
            value: NSUnderlineStyle.single.rawValue,
            in: storage,
            range: range
        )
    }

    static func toggleStrikethrough(in storage: NSMutableAttributedString, range: NSRange) {
        toggleStyleAttribute(
            .strikethroughStyle,
            value: NSUnderlineStyle.single.rawValue,
            in: storage,
            range: range
        )
    }

    static func toggleHighlight(in storage: NSMutableAttributedString, range: NSRange) {
        guard range.length > 0 else { return }
        var shouldClear = true
        storage.enumerateAttribute(.backgroundColor, in: range) { value, _, stop in
            if value == nil {
                shouldClear = false
                stop.pointee = true
            }
        }
        if shouldClear {
            storage.removeAttribute(.backgroundColor, range: range)
        } else {
            storage.addAttribute(.backgroundColor, value: highlightColor, range: range)
        }
    }

    static func applyLink(_ url: URL?, to storage: NSMutableAttributedString, range: NSRange) {
        guard range.length > 0 else { return }
        if let url {
            storage.addAttribute(.link, value: url, range: range)
            storage.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: range)
        } else {
            storage.removeAttribute(.link, range: range)
        }
    }

    static func applyList(
        _ kind: ListKind,
        to storage: NSMutableAttributedString,
        range: NSRange
    ) {
        let marker: String?
        switch kind {
        case .bulleted: marker = "{disc}"
        case .dashed: marker = "{hyphen}"
        case .numbered: marker = "{decimal}."
        case .none, .checklist: marker = nil
        }
        let list = marker.map { NSTextList(markerFormat: NSTextList.MarkerFormat(rawValue: $0), options: 0) }
        for originalRange in paragraphRanges(in: storage, range: range).reversed() {
            let checked = storage.mutableString.substring(with: originalRange).hasPrefix("☑ ")
            let indent = currentIndent(in: storage, at: originalRange.location)
            let paragraphRange = stripChecklistMarkers(in: storage, range: originalRange)
            storage.removeAttribute(checklistAttribute, range: paragraphRange)
            if paragraphRange.length != originalRange.length {
                storage.removeAttribute(.strikethroughStyle, range: paragraphRange)
                storage.addAttribute(.foregroundColor, value: textColor, range: paragraphRange)
            }
            switch kind {
            case .none:
                storage.addAttribute(
                    .paragraphStyle, value: paragraphStyle(indent: indent, list: nil), range: paragraphRange)
            case .bulleted, .dashed, .numbered:
                storage.addAttribute(
                    .paragraphStyle, value: paragraphStyle(indent: indent, list: list), range: paragraphRange)
            case .checklist:
                applyChecklist(checked: checked, to: storage, range: paragraphRange, indent: indent)
            }
        }
    }

    static func paragraphRanges(in storage: NSAttributedString, range: NSRange) -> [NSRange] {
        let string = storage.string as NSString
        let full = string.paragraphRange(for: range)
        if full.length == 0 { return [full] }
        var result: [NSRange] = []
        var location = full.location
        while location < NSMaxRange(full) {
            let paragraph = string.paragraphRange(for: NSRange(location: location, length: 0))
            result.append(paragraph)
            location = NSMaxRange(paragraph)
        }
        return result
    }

    static func indent(
        by steps: Int,
        in storage: NSMutableAttributedString,
        range: NSRange
    ) {
        let paragraphRange = storage.mutableString.paragraphRange(for: range)
        guard paragraphRange.length > 0 else { return }
        let current = currentIndent(in: storage, at: paragraphRange.location)
        let next = max(0, current + CGFloat(steps) * indentStep)
        let lists =
            (storage.attribute(
                .paragraphStyle, at: paragraphRange.location, effectiveRange: nil
            ) as? NSParagraphStyle)?.textLists
        storage.addAttribute(
            .paragraphStyle,
            value: paragraphStyle(indent: next, list: lists?.first),
            range: paragraphRange
        )
    }

    static func toggleChecklistItem(
        in storage: NSMutableAttributedString,
        at location: Int
    ) {
        guard storage.length > 0 else { return }
        let index = min(max(location, 0), storage.length - 1)
        let paragraphRange = storage.mutableString.paragraphRange(
            for: NSRange(location: index, length: 0)
        )
        let checked =
            (storage.attribute(checklistAttribute, at: paragraphRange.location, effectiveRange: nil)
            as? NSNumber)?.boolValue ?? false
        applyChecklist(
            checked: !checked,
            to: storage,
            range: paragraphRange,
            indent: currentIndent(in: storage, at: paragraphRange.location)
        )
    }

    static func restoringDynamicColors(in attributed: NSAttributedString) -> NSAttributedString {
        let storage = NSMutableAttributedString(attributedString: attributed)
        guard storage.length > 0 else { return storage }
        let full = NSRange(location: 0, length: storage.length)
        storage.enumerateAttributes(in: full) { attributes, range, _ in
            let done = (attributes[checklistAttribute] as? NSNumber)?.boolValue == true
            storage.addAttribute(.foregroundColor, value: done ? doneColor : textColor, range: range)
            if attributes[.backgroundColor] != nil {
                storage.addAttribute(.backgroundColor, value: highlightColor, range: range)
            }
        }
        return storage
    }

    static func restoringChecklists(in attributed: NSAttributedString) -> NSAttributedString {
        let storage = NSMutableAttributedString(attributedString: attributed)
        let nsString = storage.mutableString as NSString
        var location = 0
        while location < nsString.length {
            let paragraphRange = nsString.paragraphRange(for: NSRange(location: location, length: 0))
            let paragraph = nsString.substring(with: paragraphRange)
            if paragraph.hasPrefix("☐ ") || paragraph.hasPrefix("☑ ") {
                let checked = paragraph.hasPrefix("☑ ")
                applyChecklist(
                    checked: checked,
                    to: storage,
                    range: paragraphRange,
                    indent: currentIndent(in: storage, at: paragraphRange.location)
                )
            }
            location = paragraphRange.location + paragraphRange.length
        }
        return storage
    }

    static func isChecklistParagraph(_ storage: NSAttributedString, at location: Int) -> Bool {
        guard storage.length > 0 else { return false }
        let index = min(max(location, 0), storage.length - 1)
        return storage.attribute(checklistAttribute, at: index, effectiveRange: nil) != nil
    }

    private static func applyChecklist(
        checked: Bool,
        to storage: NSMutableAttributedString,
        range: NSRange,
        indent: CGFloat
    ) {
        let body = NSMutableAttributedString(attributedString: storage.attributedSubstring(from: range))
        if body.string.hasPrefix("☐ ") || body.string.hasPrefix("☑ ") {
            body.deleteCharacters(in: NSRange(location: 0, length: 2))
        }
        let marker = checked ? "☑ " : "☐ "
        let markerAttributes =
            body.length > 0 ? body.attributes(at: 0, effectiveRange: nil) : bodyAttributes()
        body.insert(NSAttributedString(string: marker, attributes: markerAttributes), at: 0)
        storage.replaceCharacters(in: range, with: body)
        let nextRange = NSRange(location: range.location, length: body.length)
        storage.addAttribute(checklistAttribute, value: NSNumber(value: checked), range: nextRange)
        storage.addAttribute(
            .paragraphStyle,
            value: paragraphStyle(indent: indent, list: nil),
            range: nextRange
        )
        if checked {
            storage.addAttribute(
                .strikethroughStyle,
                value: NSUnderlineStyle.single.rawValue,
                range: nextRange
            )
            storage.addAttribute(.foregroundColor, value: doneColor, range: nextRange)
        } else {
            storage.removeAttribute(.strikethroughStyle, range: nextRange)
            storage.addAttribute(.foregroundColor, value: textColor, range: nextRange)
        }
    }

    private static func stripChecklistMarkers(
        in storage: NSMutableAttributedString,
        range: NSRange
    ) -> NSRange {
        let paragraph = storage.mutableString.substring(with: range)
        guard paragraph.hasPrefix("☐ ") || paragraph.hasPrefix("☑ ") else { return range }
        storage.deleteCharacters(in: NSRange(location: range.location, length: 2))
        return NSRange(location: range.location, length: range.length - 2)
    }

    private static func toggleStyleAttribute(
        _ key: NSAttributedString.Key,
        value: Int,
        in storage: NSMutableAttributedString,
        range: NSRange
    ) {
        guard range.length > 0 else { return }
        var shouldClear = true
        storage.enumerateAttribute(key, in: range) { existing, _, stop in
            if (existing as? Int ?? 0) == 0 {
                shouldClear = false
                stop.pointee = true
            }
        }
        if shouldClear {
            storage.removeAttribute(key, range: range)
        } else {
            storage.addAttribute(key, value: value, range: range)
        }
    }

    private static func currentIndent(in storage: NSAttributedString, at location: Int) -> CGFloat {
        guard storage.length > 0 else { return 0 }
        let index = min(max(location, 0), storage.length - 1)
        let style = storage.attribute(.paragraphStyle, at: index, effectiveRange: nil) as? NSParagraphStyle
        return style?.headIndent ?? 0
    }

    private static func paragraphStyle(indent: CGFloat, list: NSTextList?) -> NSMutableParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.headIndent = indent
        style.firstLineHeadIndent = indent
        if let list {
            style.textLists = [list]
        }
        return style
    }

    private static func styledFont(
        _ textStyle: UIFont.TextStyle, weight: UIFont.Weight, traits: UITraitCollection?
    ) -> UIFont {
        let base = UIFont.preferredFont(forTextStyle: textStyle, compatibleWith: traits)
        let descriptor = base.fontDescriptor.addingAttributes([
            .traits: [UIFontDescriptor.TraitKey.weight: weight]
        ])
        return UIFont(descriptor: descriptor, size: base.pointSize)
    }
}
