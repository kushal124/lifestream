import Cockpit
import SwiftUI
import UIKit

final class NoteChecklistAttachment: NSTextAttachment {
    let isChecked: Bool

    init(isChecked: Bool) {
        self.isChecked = isChecked
        super.init(data: nil, ofType: nil)
    }

    required init?(coder: NSCoder) {
        isChecked = coder.decodeBool(forKey: "isChecked")
        super.init(coder: coder)
    }

    override func encode(with coder: NSCoder) {
        super.encode(with: coder)
        coder.encode(isChecked, forKey: "isChecked")
    }
}

enum NoteChecklistGlyphs {
    static let unchecked = "☐"
    static let checked = "☑"
    static let attachmentCharacter = "\u{FFFC}"
    static let trailingGap: CGFloat = 4

    static func displaying(
        _ model: NSAttributedString, traits: UITraitCollection
    ) -> NSMutableAttributedString {
        let storage = NSMutableAttributedString(attributedString: model)
        let string = storage.mutableString
        var location = 0
        while location < string.length {
            let paragraph = string.paragraphRange(for: NSRange(location: location, length: 0))
            defer { location = NSMaxRange(paragraph) }
            guard paragraph.length >= 2 else { continue }
            let text = string.substring(with: paragraph)
            let isChecked: Bool
            if text.hasPrefix(unchecked + " ") {
                isChecked = false
            } else if text.hasPrefix(checked + " ") {
                isChecked = true
            } else {
                continue
            }
            let markerRange = NSRange(location: paragraph.location, length: 1)
            var attributes = storage.attributes(at: paragraph.location, effectiveRange: nil)
            let font = (attributes[.font] as? UIFont) ?? NoteFormatting.font(for: .body)
            let attachment = checkbox(isChecked: isChecked, font: font, traits: traits)
            attributes[.attachment] = attachment
            storage.replaceCharacters(
                in: markerRange,
                with: NSAttributedString(string: attachmentCharacter, attributes: attributes)
            )
        }
        return storage
    }

    static func restoringGlyphs(_ display: NSAttributedString) -> NSMutableAttributedString {
        let storage = NSMutableAttributedString(attributedString: display)
        guard storage.length > 0 else { return storage }
        var replacements: [(NSRange, String)] = []
        storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) {
            value, range, _ in
            guard let attachment = value as? NoteChecklistAttachment else { return }
            storage.removeAttribute(.attachment, range: range)
            let glyph = attachment.isChecked ? checked : unchecked
            let string = storage.mutableString
            var index = range.location
            while index < NSMaxRange(range) {
                if string.substring(with: NSRange(location: index, length: 1)) == attachmentCharacter {
                    replacements.append((NSRange(location: index, length: 1), glyph))
                }
                index += 1
            }
        }
        for (range, glyph) in replacements.reversed() {
            let attributes = storage.attributes(at: range.location, effectiveRange: nil)
            storage.replaceCharacters(in: range, with: NSAttributedString(string: glyph, attributes: attributes))
        }
        return storage
    }

    static func markerState(in text: NSAttributedString, paragraph: NSRange) -> Bool? {
        guard paragraph.length >= 2 else { return nil }
        let prefix = (text.string as NSString).substring(with: NSRange(location: paragraph.location, length: 2))
        if prefix == unchecked + " " { return false }
        if prefix == checked + " " { return true }
        if prefix == attachmentCharacter + " ",
            let attachment = text.attribute(.attachment, at: paragraph.location, effectiveRange: nil)
                as? NoteChecklistAttachment
        {
            return attachment.isChecked
        }
        return nil
    }

    static func stripAttachment(from attributes: [NSAttributedString.Key: Any]) -> [NSAttributedString.Key: Any] {
        var attributes = attributes
        attributes[.attachment] = nil
        return attributes
    }

    static func checkbox(isChecked: Bool, font: UIFont, traits: UITraitCollection) -> NoteChecklistAttachment {
        let attachment = NoteChecklistAttachment(isChecked: isChecked)
        let side = (font.pointSize * 1.3).rounded()
        let canvas = CGSize(width: side + trailingGap, height: side)
        let box = CGRect(x: 0, y: 0, width: side, height: side)
        let format = UIGraphicsImageRendererFormat.preferred()
        if traits.displayScale > 0 { format.scale = traits.displayScale }
        attachment.image = UIGraphicsImageRenderer(size: canvas, format: format).image { context in
            if isChecked {
                NoteFormatting.textColor.resolvedColor(with: traits).setFill()
                UIBezierPath(ovalIn: box).fill()
                let check = box.insetBy(dx: side * 0.22, dy: side * 0.22)
                UIColor(Cockpit.Color.textInverse).resolvedColor(with: traits).setFill()
                context.cgContext.addPath(IconShape(meaning: .done).path(in: check).cgPath)
                context.cgContext.fillPath()
            } else {
                let width = side / 16
                UIColor(Cockpit.Color.strokeControl).resolvedColor(with: traits).setStroke()
                let ring = UIBezierPath(ovalIn: box.insetBy(dx: width / 2, dy: width / 2))
                ring.lineWidth = width
                ring.stroke()
            }
        }
        attachment.bounds = CGRect(
            x: 0,
            y: ((font.capHeight - side) / 2).rounded(),
            width: canvas.width,
            height: canvas.height
        )
        return attachment
    }
}

@MainActor
final class NoteEditorSession: ObservableObject {
    let noteID: UUID
    let createdAt: Date
    @Published var attributed: NSMutableAttributedString
    @Published var isDirty = false
    @Published var isEditing = false
    @Published var isShowingFormatCard = false
    var drawsCheckboxes = false
    weak var textView: UITextView?
    private var isApplyingExternalChange = false

    init(noteID: UUID, createdAt: Date, attributed: NSAttributedString) {
        self.noteID = noteID
        self.createdAt = createdAt
        self.attributed = NSMutableAttributedString(attributedString: attributed)
    }

    func bind(textView: UITextView) {
        self.textView = textView
        applyToTextView()
    }

    func textDidChange(_ textView: UITextView) {
        guard !isApplyingExternalChange else { return }
        attributed = modelText(of: textView)
        if !isDirty { isDirty = true }
    }

    func selectionDidChange() {
        guard !isApplyingExternalChange else { return }
        objectWillChange.send()
    }

    func refreshDisplay() {
        attributed = NSMutableAttributedString(
            attributedString: NoteFormatting.restoringDynamicColors(
                in: NoteFormatting.restoringTextStyles(in: attributed)))
        applyToTextView(keepingSelection: true)
    }

    func applyToStorage(_ transform: (NSMutableAttributedString, NSRange) -> Void) {
        guard let textView else { return }
        let storage = modelText(of: textView)
        let range = textView.selectedRange
        let originalLength = storage.length
        transform(storage, range)
        let delta = storage.length - originalLength
        let location = min(storage.length, max(0, range.location + (range.length == 0 ? delta : 0)))
        let length = min(storage.length - location, max(0, range.length + (range.length == 0 ? 0 : delta)))
        replaceContents(
            storage, selection: NSRange(location: location, length: length), typing: textView.typingAttributes
        )
    }

    func applyInline(_ transform: (NSMutableAttributedString, NSRange) -> Void) {
        guard let textView else { return }
        if textView.selectedRange.length > 0 {
            applyToStorage(transform)
        } else {
            let sample = NSMutableAttributedString(string: "x", attributes: currentTypingAttributes())
            transform(sample, NSRange(location: 0, length: sample.length))
            textView.typingAttributes = sample.attributes(at: 0, effectiveRange: nil)
            objectWillChange.send()
        }
    }

    func applyParagraph(_ transform: (NSMutableAttributedString, NSRange) -> Void) {
        guard let textView else { return }
        let paragraph = (textView.text as NSString).paragraphRange(for: textView.selectedRange)
        if paragraph.length == 0 {
            applyInline(transform)
        } else {
            applyToStorage(transform)
            guard textView.textStorage.length > 0 else {
                textView.typingAttributes = NoteFormatting.bodyAttributes()
                return
            }
            let index = min(textView.selectedRange.location, textView.textStorage.length - 1)
            textView.typingAttributes = NoteChecklistGlyphs.stripAttachment(
                from: textView.textStorage.attributes(at: index, effectiveRange: nil))
        }
    }

    func applyList(_ kind: NoteFormatting.ListKind) {
        let transform: (NSMutableAttributedString, NSRange) -> Void = { storage, range in
            NoteFormatting.applyList(kind, to: storage, range: range)
        }
        if kind == .checklist {
            applyToStorage(transform)
            if let textView, textView.textStorage.length > 0 {
                textView.typingAttributes = NoteChecklistGlyphs.stripAttachment(
                    from: textView.textStorage.attributes(
                        at: min(textView.selectedRange.location, textView.textStorage.length - 1),
                        effectiveRange: nil))
            }
        } else {
            applyParagraph(transform)
        }
    }

    var isChecklistSelection: Bool {
        guard let textView else { return false }
        let text = textView.attributedText ?? NSAttributedString()
        return NoteFormatting.paragraphRanges(in: text, range: textView.selectedRange)
            .allSatisfy { NoteChecklistGlyphs.markerState(in: text, paragraph: $0) != nil }
    }

    func currentBlockStyle() -> NoteFormatting.BlockStyle? {
        (selectedAttributes[.font] as? UIFont).flatMap(NoteFormatting.blockStyle(of:))
    }

    func toggleChecklist() {
        applyList(isChecklistSelection ? .none : .checklist)
    }

    func insertLink(_ url: URL) {
        let attributes = currentTypingAttributes()
        applyToStorage { storage, range in
            if range.length > 0 {
                NoteFormatting.applyLink(url, to: storage, range: range)
            } else {
                let text = NSMutableAttributedString(string: url.absoluteString, attributes: attributes)
                NoteFormatting.applyLink(url, to: text, range: NSRange(location: 0, length: text.length))
                storage.insert(text, at: range.location)
            }
        }
    }

    @discardableResult
    func insertListNewline(in range: NSRange) -> Bool {
        guard let textView, textView.textStorage.length > 0 else { return false }
        let storage = modelText(of: textView)
        let paragraph = (storage.string as NSString).paragraphRange(for: range)
        let text = (storage.string as NSString).substring(with: paragraph)
        let checklist = text.hasPrefix("☐ ") || text.hasPrefix("☑ ")
        let style =
            paragraph.length > 0
            ? storage.attribute(.paragraphStyle, at: paragraph.location, effectiveRange: nil)
                as? NSParagraphStyle
            : textView.typingAttributes[.paragraphStyle] as? NSParagraphStyle
        guard checklist || !(style?.textLists.isEmpty ?? true) else { return false }
        if NoteSearchIndex.strippedMarker(text).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            NoteFormatting.applyList(.none, to: storage, range: paragraph)
            replaceContents(
                storage, selection: NSRange(location: paragraph.location, length: 0),
                typing: NoteFormatting.bodyAttributes())
            return true
        }
        var typing = NoteFormatting.bodyAttributes()
        if let style { typing[.paragraphStyle] = style }
        storage.replaceCharacters(in: range, with: NSAttributedString(string: "\n", attributes: typing))
        var caret = range.location + 1
        if checklist {
            NoteFormatting.applyList(.checklist, to: storage, range: NSRange(location: caret, length: 0))
            caret += 2
            typing = storage.attributes(at: caret - 1, effectiveRange: nil)
        }
        replaceContents(storage, selection: NSRange(location: caret, length: 0), typing: typing)
        return true
    }

    func insertBodyNewline(in range: NSRange) {
        guard let textView else { return }
        let storage = modelText(of: textView)
        let typing = NoteFormatting.bodyAttributes()
        storage.replaceCharacters(in: range, with: NSAttributedString(string: "\n", attributes: typing))
        replaceContents(storage, selection: NSRange(location: range.location + 1, length: 0), typing: typing)
    }

    private func replaceContents(
        _ contents: NSAttributedString, selection: NSRange, typing: [NSAttributedString.Key: Any]
    ) {
        guard let textView else { return }
        let previous = modelText(of: textView)
        let previousSelection = textView.selectedRange
        let previousTyping = textView.typingAttributes
        textView.undoManager?.registerUndo(withTarget: self) { target in
            target.replaceContents(previous, selection: previousSelection, typing: previousTyping)
        }
        textView.textStorage.setAttributedString(displayText(for: contents))
        textView.selectedRange = selection
        textView.typingAttributes = NoteChecklistGlyphs.stripAttachment(from: typing)
        textDidChange(textView)
    }

    func currentTypingAttributes() -> [NSAttributedString.Key: Any] {
        if let textView, !textView.typingAttributes.isEmpty {
            return NoteChecklistGlyphs.stripAttachment(from: textView.typingAttributes)
        }
        return NoteFormatting.attributes(for: .title)
    }

    private var selectedAttributes: [NSAttributedString.Key: Any] {
        if let textView, textView.selectedRange.length > 0 {
            return textView.textStorage.attributes(at: textView.selectedRange.location, effectiveRange: nil)
        }
        return currentTypingAttributes()
    }

    func isTraitActive(_ trait: UIFontDescriptor.SymbolicTraits) -> Bool {
        (selectedAttributes[.font] as? UIFont)?.fontDescriptor.symbolicTraits.contains(trait) == true
    }

    func isAttributeActive(_ attribute: NSAttributedString.Key) -> Bool {
        guard let value = selectedAttributes[attribute] else { return false }
        if let number = value as? NSNumber { return number.intValue != 0 }
        return true
    }

    private func modelText(of textView: UITextView) -> NSMutableAttributedString {
        let shown = textView.attributedText ?? NSAttributedString()
        return drawsCheckboxes
            ? NoteChecklistGlyphs.restoringGlyphs(shown)
            : NSMutableAttributedString(attributedString: shown)
    }

    private func displayText(for model: NSAttributedString) -> NSAttributedString {
        guard drawsCheckboxes else { return model }
        return NoteChecklistGlyphs.displaying(model, traits: textView?.traitCollection ?? .current)
    }

    private func applyToTextView(keepingSelection: Bool = false) {
        guard let textView else { return }
        isApplyingExternalChange = true
        let selected = textView.selectedRange
        textView.attributedText = displayText(for: attributed)
        let maxLocation = attributed.length
        let location = min(selected.location, maxLocation)
        textView.selectedRange = NSRange(
            location: location,
            length: keepingSelection ? min(selected.length, maxLocation - location) : 0
        )
        isApplyingExternalChange = false
    }

}

final class NoteInputHostView: UIInputView {
    private let host: UIHostingController<AnyView>
    private let contentHeight: CGFloat
    private var bottomPadding: CGFloat = 0
    private var sizingHeight: NSLayoutConstraint?

    init(root: AnyView, height: CGFloat) {
        host = UIHostingController(rootView: root)
        contentHeight = height
        super.init(frame: CGRect(x: 0, y: 0, width: 0, height: height), inputViewStyle: .keyboard)
        allowsSelfSizing = true
        autoresizingMask = .flexibleHeight
        sizingHeight = heightAnchor.constraint(equalToConstant: height)
        sizingHeight?.isActive = true
        host.safeAreaRegions = []
        host.view.backgroundColor = .clear
        host.view.translatesAutoresizingMaskIntoConstraints = false
        addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: trailingAnchor),
            host.view.topAnchor.constraint(equalTo: topAnchor),
            host.view.heightAnchor.constraint(equalToConstant: height),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("NoteInputHostView is code-only") }

    func update(root: AnyView) { host.rootView = root }

    @discardableResult
    func setBottomPadding(_ padding: CGFloat) -> Bool {
        guard padding != bottomPadding else { return false }
        bottomPadding = padding
        sizingHeight?.constant = contentHeight + padding
        frame.size.height = contentHeight + padding
        invalidateIntrinsicContentSize()
        return true
    }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: contentHeight + bottomPadding)
    }

    override func systemLayoutSizeFitting(_ targetSize: CGSize) -> CGSize {
        CGSize(width: targetSize.width, height: contentHeight + bottomPadding)
    }

    override func systemLayoutSizeFitting(
        _ targetSize: CGSize,
        withHorizontalFittingPriority horizontalFittingPriority: UILayoutPriority,
        verticalFittingPriority: UILayoutPriority
    ) -> CGSize {
        CGSize(width: targetSize.width, height: contentHeight + bottomPadding)
    }
}

final class NotesEditorTextView: UITextView {
    var onAttachedToWindow: (() -> Void)?
    var onTraitChange: (() -> Void)?
    private var didRegisterTraits = false
    private var accessoryHost: NoteInputHostView?
    private var formatHost: NoteInputHostView?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if !didRegisterTraits {
            didRegisterTraits = true
            NotificationCenter.default.addObserver(
                self, selector: #selector(keyboardWillChangeFrame(_:)),
                name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
            registerForTraitChanges([
                UITraitUserInterfaceStyle.self, UITraitPreferredContentSizeCategory.self,
            ]) { (view: NotesEditorTextView, _) in
                view.onTraitChange?()
            }
        }
        if window != nil {
            onTraitChange?()
            onAttachedToWindow?()
        }
    }

    override var accessibilityValue: String? {
        get { NoteChecklistGlyphs.restoringGlyphs(attributedText ?? NSAttributedString()).string }
        set {}
    }

    func setAccessoryBar<Bar: View>(_ bar: Bar) {
        if let accessoryHost {
            accessoryHost.update(root: AnyView(bar))
        } else {
            let host = makeInputHost(AnyView(bar), height: NoteAccessoryBar.height)
            accessoryHost = host
            inputAccessoryView = host
        }
    }

    var isShowingFormatCard: Bool { inputView != nil }

    func showFormatCard<Card: View>(_ card: Card) {
        if let formatHost {
            formatHost.update(root: AnyView(card))
        } else {
            formatHost = makeInputHost(AnyView(card), height: NoteFormatCard.height)
        }
        formatHost?.setBottomPadding(homeIndicatorInset)
        accessoryHost?.setBottomPadding(0)
        guard inputView == nil else { return }
        inputView = formatHost
        reloadInputViews()
    }

    private func makeInputHost(_ root: AnyView, height: CGFloat) -> NoteInputHostView {
        NoteInputHostView(root: root, height: height)
    }

    private var homeIndicatorInset: CGFloat {
        window?.rootViewController?.view.safeAreaInsets.bottom ?? safeAreaInsets.bottom
    }

    @objc private func keyboardWillChangeFrame(_ notification: Notification) {
        guard isFirstResponder,
            let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect
        else { return }
        let inset = homeIndicatorInset
        let hardwareKeyboard = frame.height <= NoteAccessoryBar.height + inset + 1
        let padding = hardwareKeyboard && !isShowingFormatCard ? inset : 0
        if accessoryHost?.setBottomPadding(padding) == true {
            DispatchQueue.main.async { [weak self] in self?.reloadInputViews() }
        }
    }

    func hideFormatCard() {
        guard inputView != nil else { return }
        inputView = nil
        reloadInputViews()
    }
}

struct NoteTextView: UIViewRepresentable {
    @ObservedObject var session: NoteEditorSession
    var onChange: () -> Void
    var onChecklistToggle: (Int) -> Void
    var onAttach: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(session: session, onChange: onChange, onChecklistToggle: onChecklistToggle)
    }

    func makeUIView(context: Context) -> NotesEditorTextView {
        let textView = NotesEditorTextView()
        textView.backgroundColor = NoteFormatting.pageColor
        textView.tintColor = NoteFormatting.textColor
        textView.linkTextAttributes = [
            .foregroundColor: NoteFormatting.textColor,
            .underlineStyle: NSUnderlineStyle.single.rawValue,
        ]
        textView.textContainerInset = UIEdgeInsets(
            top: Cockpit.Space.s2, left: Cockpit.Space.s5, bottom: Cockpit.Space.s6, right: Cockpit.Space.s5)
        textView.textContainer.lineFragmentPadding = 0
        textView.keyboardDismissMode = .interactive
        textView.alwaysBounceVertical = true
        textView.allowsEditingTextAttributes = true
        textView.adjustsFontForContentSizeCategory = true
        textView.isAccessibilityElement = true
        textView.accessibilityIdentifier = "notes.editor.body"
        textView.accessibilityLabel = "Note"
        textView.typingAttributes = NoteFormatting.attributes(for: .title)
        textView.onAttachedToWindow = { [weak textView] in
            context.coordinator.focusIfEmpty(textView)
        }
        textView.onTraitChange = { [weak session] in
            DispatchQueue.main.async { [weak session] in
                session?.refreshDisplay()
            }
        }
        let tap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleTap(_:))
        )
        tap.delegate = context.coordinator
        textView.addGestureRecognizer(tap)
        session.drawsCheckboxes = true
        session.bind(textView: textView)
        context.coordinator.onAttach = onAttach
        context.coordinator.installInputViews(on: textView)
        context.coordinator.updateChecklistActions(textView)
        textView.delegate = context.coordinator
        return textView
    }

    func updateUIView(_ textView: NotesEditorTextView, context: Context) {
        context.coordinator.session = session
        context.coordinator.onChange = onChange
        context.coordinator.onChecklistToggle = onChecklistToggle
        context.coordinator.onAttach = onAttach
        if textView !== session.textView {
            session.drawsCheckboxes = true
            session.bind(textView: textView)
        }
        context.coordinator.installInputViews(on: textView)
        context.coordinator.focusIfEmpty(textView)
        context.coordinator.updateChecklistActions(textView)
    }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate, UIGestureRecognizerDelegate {
        var session: NoteEditorSession
        var onChange: () -> Void
        var onChecklistToggle: (Int) -> Void
        var onAttach: () -> Void = {}
        var didFocusEmptyNote = false

        func focusIfEmpty(_ textView: UITextView?) {
            guard let textView, session.attributed.length == 0, !didFocusEmptyNote else { return }
            didFocusEmptyNote = true
            DispatchQueue.main.async {
                textView.becomeFirstResponder()
            }
        }

        init(
            session: NoteEditorSession,
            onChange: @escaping () -> Void,
            onChecklistToggle: @escaping (Int) -> Void
        ) {
            self.session = session
            self.onChange = onChange
            self.onChecklistToggle = onChecklistToggle
        }

        func installInputViews(on textView: NotesEditorTextView) {
            let session = session
            let bar = NoteAccessoryBar(
                session: session,
                onChange: { [weak self] in self?.onChange() },
                onFormat: { [weak self, weak textView] in
                    guard let self, let textView else { return }
                    if textView.isShowingFormatCard {
                        textView.hideFormatCard()
                        session.isShowingFormatCard = false
                    } else {
                        textView.showFormatCard(self.formatCard())
                        session.isShowingFormatCard = true
                    }
                },
                onAttach: { [weak self] in self?.onAttach() },
                onDismissKeyboard: { [weak textView] in textView?.resignFirstResponder() }
            )
            textView.setAccessoryBar(bar)
            if textView.isShowingFormatCard {
                textView.showFormatCard(formatCard())
            }
        }

        private func formatCard() -> NoteFormatCard {
            NoteFormatCard(
                session: session,
                onChange: { [weak self] in self?.onChange() },
                onClose: { [weak self] in
                    guard let self, let textView = self.session.textView as? NotesEditorTextView else { return }
                    textView.hideFormatCard()
                    self.session.isShowingFormatCard = false
                }
            )
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            DispatchQueue.main.async { [weak self, weak textView] in
                guard let self, textView?.isFirstResponder == true else { return }
                self.session.isEditing = true
            }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            (textView as? NotesEditorTextView)?.hideFormatCard()
            DispatchQueue.main.async { [weak self, weak textView] in
                guard let self, textView?.isFirstResponder != true else { return }
                self.session.isEditing = false
                self.session.isShowingFormatCard = false
            }
        }

        func textViewDidChange(_ textView: UITextView) {
            session.textDidChange(textView)
            updateChecklistActions(textView)
            onChange()
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            session.selectionDidChange()
            updateChecklistActions(textView)
        }

        func textView(
            _ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction
        ) -> UIAction? {
            isChecklistItem(textItem) ? nil : defaultAction
        }

        func textView(
            _ textView: UITextView, menuConfigurationFor textItem: UITextItem, defaultMenu: UIMenu
        ) -> UITextItem.MenuConfiguration? {
            isChecklistItem(textItem) ? nil : UITextItem.MenuConfiguration(menu: defaultMenu)
        }

        private func isChecklistItem(_ item: UITextItem) -> Bool {
            if case .textAttachment(let attachment) = item.content {
                return attachment is NoteChecklistAttachment
            }
            return false
        }

        func updateChecklistActions(_ textView: UITextView) {
            let storage = textView.attributedText ?? NSAttributedString()
            textView.accessibilityCustomActions = NoteFormatting.paragraphRanges(
                in: storage, range: NSRange(location: 0, length: storage.length)
            ).compactMap { range in
                guard let checked = NoteChecklistGlyphs.markerState(in: storage, paragraph: range) else {
                    return nil
                }
                let text = (storage.string as NSString).substring(with: range)
                let title = String(text.dropFirst(2)).trimmingCharacters(in: .whitespacesAndNewlines)
                return UIAccessibilityCustomAction(
                    name: "\(checked ? "Uncheck" : "Check") \(title.isEmpty ? "item" : title)"
                ) { [weak self, weak textView] _ in
                    guard let self, let textView else { return false }
                    self.onChecklistToggle(range.location)
                    self.updateChecklistActions(textView)
                    return true
                }
            }
        }

        func textView(
            _ textView: UITextView,
            shouldChangeTextIn range: NSRange,
            replacementText text: String
        ) -> Bool {
            if text == "\n" {
                if session.insertListNewline(in: range) {
                    updateChecklistActions(textView)
                    onChange()
                    return false
                }
                if textView.markedTextRange != nil {
                    DispatchQueue.main.async { [weak textView] in
                        guard let textView else { return }
                        textView.typingAttributes = NoteFormatting.bodyAttributes()
                    }
                    return true
                }
                session.insertBodyNewline(in: range)
                updateChecklistActions(textView)
                onChange()
                return false
            }
            return true
        }

        @objc func handleTap(_ gesture: UITapGestureRecognizer) {
            guard let textView = gesture.view as? UITextView else { return }
            let point = gesture.location(in: textView)
            guard let shown = textView.attributedText, shown.length > 0 else { return }
            let index: Int
            if let position = textView.closestPosition(to: point) {
                index = textView.offset(from: textView.beginningOfDocument, to: position)
            } else {
                index = 0
            }
            let paragraph = (shown.string as NSString).paragraphRange(
                for: NSRange(location: min(max(index, 0), shown.length - 1), length: 0)
            )
            let style =
                shown.attribute(.paragraphStyle, at: paragraph.location, effectiveRange: nil)
                as? NSParagraphStyle
            let markerX = textView.textContainerInset.left + (style?.firstLineHeadIndent ?? 0)
            guard let start = textView.position(from: textView.beginningOfDocument, offset: paragraph.location),
                let end = textView.position(from: start, offset: 1),
                let markerRange = textView.textRange(from: start, to: end)
            else { return }
            let markerRect = textView.firstRect(for: markerRange)
            let verticalPadding = max(0, (Cockpit.Size.target - markerRect.height) / 2)
            guard point.y >= markerRect.minY - verticalPadding,
                point.y <= markerRect.maxY + verticalPadding
            else { return }
            if NoteChecklistGlyphs.markerState(in: shown, paragraph: paragraph) != nil,
                point.x >= markerX - 10, point.x <= markerX + 34
            {
                onChecklistToggle(paragraph.location)
                updateChecklistActions(textView)
            }
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            true
        }
    }
}
