import AppKit

@MainActor enum UninstallWindows {
    static func ask(_ plan: Uninstall.Plan?) -> Bool? {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Uninstall Lifestream?"
        alert.informativeText = UninstallWords.question(plan)
        let uninstall = alert.addButton(withTitle: "Uninstall")
        uninstall.hasDestructiveAction = true
        let erasable = plan?.folder != nil
        if erasable { alert.addButton(withTitle: "Uninstall and Erase Everything…").hasDestructiveAction = true }
        alert.addButton(withTitle: "Cancel").keyEquivalent = "\u{1b}"
        switch alert.runModal() {
        case .alertFirstButtonReturn: return false
        case .alertSecondButtonReturn where erasable: return confirmErase(plan!)
        default: return nil
        }
    }

    private static func confirmErase(_ plan: Uninstall.Plan) -> Bool? {
        let alert = NSAlert()
        if let refused = plan.refused {
            alert.messageText = "Lifestream can't erase what it kept"
            alert.informativeText = "\(refused)\n\nNothing was removed."
            alert.addButton(withTitle: "OK")
            alert.runModal()
            return nil
        }
        alert.alertStyle = .critical
        alert.messageText = "Erase everything Lifestream kept?"
        alert.informativeText = UninstallWords.erase(folder: plan.folder ?? "")
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Erase Everything").hasDestructiveAction = true
        return alert.runModal() == .alertSecondButtonReturn ? true : nil
    }

    static func done(_ outcome: Uninstall.Outcome) -> Bool {
        let alert = NSAlert()
        alert.messageText = outcome.stopped == nil ? "Lifestream is uninstalled" : "Lifestream wasn't uninstalled"
        alert.informativeText = UninstallWords.done(outcome)
        alert.addButton(withTitle: "Done")
        guard outcome.stopped == nil else {
            alert.runModal()
            return false
        }
        alert.addButton(withTitle: "Show How")
        return alert.runModal() == .alertSecondButtonReturn
    }

    @MainActor final class Progress {
        private let panel: NSPanel
        private let line = NSTextField(labelWithString: "")

        init() {
            panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 380, height: 96), styleMask: [.titled], backing: .buffered, defer: false)
            panel.title = "Uninstalling Lifestream"
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .small
            spinner.startAnimation(nil)
            let stack = NSStackView(views: [spinner, line])
            stack.orientation = .horizontal
            stack.spacing = 10
            stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
            panel.contentView = stack
        }

        private func show() {
            panel.center()
            panel.makeKeyAndOrderFront(nil)
        }

        func say(_ words: String) {
            if !panel.isVisible { show() }
            line.stringValue = words + "…"
        }

        func close() {
            panel.orderOut(nil)
        }
    }
}

enum UninstallWords {
    static let page = URL(string: "https://trylifestream.com/uninstall/")!

    static let keptKey = "This Mac's Keychain keeps the key to Lifestream's vault, so setting Lifestream up here again opens it without your recovery key."
    static let keptHomeKey = "This Mac's Keychain keeps the key that opens it, so setting Lifestream up here again opens it without your recovery key."
    static let reached = "The devices and agents it knew can no longer reach it."
    static let noneHad = "No device or agent had access to it."
    static let keepAccess = "Your devices keep their access until you remove them in Devices."
    static let loseAccess = "Your iPhone, the Chrome extension and any agents lose their access to Lifestream."

    static func kept(keyed: Bool) -> String {
        keyed ? keptHomeKey : keptKey
    }
    static let unsavedKey = "Your recovery key isn't saved. Lifestream asks you to save it when you set it up again."
    static let leaving = "Save your recovery key before Lifestream leaves this Mac."
    static let leavingDetail = "Uninstall goes on once it's saved."

    static func question(_ plan: Uninstall.Plan?) -> String {
        let access = plan.flatMap { $0.closesAccess ? loseAccess : $0.folder == nil ? nil : keepAccess }
        var words = ["Lifestream stops and leaves this Mac: the app, its background jobs, its access to Lifestream, and its captures, logs and caches.",
                     access, "What this Mac captured and has not sent yet is lost."].compactMap { $0 }.joined(separator: " ")
        guard let folder = plan?.folder else { return words }
        let keyed = plan?.keyed == true
        words += "\n\nWhat Lifestream kept stays in \(folder)\(keyed ? ", encrypted," : "") unless you erase it."
        switch plan?.recovery {
        case .confirmed?:
            words += " This Mac keeps the key \(keyed ? "that opens it" : "to its vault"), so if you set Lifestream up here again it opens what Lifestream kept without your recovery key. "
                + "On another Mac, your recovery key opens it."
        case .unconfirmed?:
            words += " Lifestream asks you to save your recovery key first: on another Mac, or if this Mac's Keychain is lost, "
                + "it is the only way into \(keyed ? "what Lifestream kept" : "Lifestream's vault")."
        case nil: break
        }
        return words
    }

    static func erase(folder: String) -> String {
        "Everything Lifestream kept in \(folder) is deleted: your messages, photos, places, days and the rest. "
            + "Nothing on your other devices or in your accounts is touched. This can't be undone."
    }

    static func done(_ outcome: Uninstall.Outcome) -> String {
        if let stopped = outcome.stopped {
            return "\(stopped)\n\nWhat Lifestream kept was not changed. Choose Uninstall Lifestream… to try again."
        }
        var lines: [String] = []
        if let applied = outcome.applied, let folder = applied.folder {
            let access = applied.revoked.map { $0 > 0 ? reached : noneHad } ?? keepAccess
            switch applied.home {
            case "erased": lines.append("Everything Lifestream kept is erased. Its keys are deleted from this Mac's Keychain.")
            case "kept": lines.append("What Lifestream kept stays in \(folder)\(outcome.keyed ? ", encrypted" : ""). \(access)"
                                      + (outcome.vault == .kept ? " " + kept(keyed: outcome.keyed) : ""))
            default: lines.append("The folder \(folder) wasn't connected, so what Lifestream kept stays as it was. \(access) " + kept(keyed: outcome.keyed))
            }
        }
        if outcome.vault == .unsaved {
            lines.append(unsavedKey)
        }
        if let drop = outcome.dropKept {
            lines.append("Your drop folder \(drop.path) still holds files: they are yours to keep or delete.")
        }
        if !outcome.failures.isEmpty {
            lines.append("These could not be removed:\n" + outcome.failures.map { "– \($0)" }.joined(separator: "\n"))
        }
        lines.append("Remove the Chrome extension and the iPhone app too: Show How opens the steps.")
        return lines.joined(separator: "\n\n")
    }
}
