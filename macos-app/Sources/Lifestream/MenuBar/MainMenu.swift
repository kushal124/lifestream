import AppKit

@MainActor enum MainMenu {
    struct Actions {
        let target: AnyObject
        let quit: Selector
        let toggle: Selector
        let shipNow: Selector
        let settings: Selector
        let tour: Tour
        let feedback: Feedback
    }

    @MainActor final class Tour: NSObject, NSMenuItemValidation {
        static let page = "view=ask&tour=1"
        private let shown: () -> WebContent?
        private let open: (String) -> Void
        private let defaults: UserDefaults

        init(shown: @escaping () -> WebContent?, defaults: UserDefaults = .standard, open: @escaping (String) -> Void) {
            self.shown = shown
            self.defaults = defaults
            self.open = open
        }

        var offered: Bool {
            guard let web = shown() else { return !WebContent.leftInOnboarding(defaults) }
            return web.view != AppSection.onboardingView
        }

        func validateMenuItem(_ menuItem: NSMenuItem) -> Bool { offered }

        @objc func show(_ sender: Any?) {
            guard offered else { return }
            open(Self.page)
        }
    }

    @MainActor final class Feedback: NSObject {
        static let page = "dialog=\(AppSection.feedback)"
        private let seen: () -> Bool
        private let open: (_ page: String, _ pictured: Bool) -> Void

        init(seen: @escaping () -> Bool, open: @escaping (_ page: String, _ pictured: Bool) -> Void) {
            self.seen = seen
            self.open = open
        }

        @objc func send(_ sender: Any?) {
            open(Self.page, seen())
        }
    }

    static func install(_ actions: Actions, presentation: RecorderPresentation) -> NSMenu {
        let main = build(actions, presentation: presentation)
        NSApp.mainMenu = main
        NSApp.windowsMenu = main.item(withTitle: "Window")?.submenu
        NSApp.helpMenu = main.item(withTitle: "Help")?.submenu
        return main
    }

    private static func build(_ actions: Actions, presentation: RecorderPresentation) -> NSMenu {
        let main = NSMenu()
        let windows = NSMenu(title: "Window")
        main.addItem(submenu("Lifestream", [
            item("About Lifestream", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item("Settings…", actions.settings, ",", target: actions.target),
            .separator(),
            item("Hide Lifestream", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit Lifestream", actions.quit, "q", target: actions.target),
        ]))
        main.addItem(submenu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ]))
        let zoomInAlternate = item("Zoom In", #selector(MainWindowController.zoomIn(_:)), "=")
        zoomInAlternate.isHidden = true
        zoomInAlternate.allowsKeyEquivalentWhenHidden = true
        let sections = AppSection.allCases.enumerated().map { index, section in
            let entry = item(section.title, #selector(MainWindowController.showSection(_:)), "\(index + 1)")
            entry.tag = index
            return entry
        }
        main.addItem(submenu("View", sections + [
            .separator(),
            item("Reload", #selector(MainWindowController.reloadPage(_:)), "r"),
            item("Back", #selector(MainWindowController.navigateBack(_:)), "["),
            item("Forward", #selector(MainWindowController.navigateForward(_:)), "]"),
            .separator(),
            item("Actual Size", #selector(MainWindowController.actualSize(_:)), "0"),
            item("Zoom In", #selector(MainWindowController.zoomIn(_:)), "+"),
            zoomInAlternate,
            item("Zoom Out", #selector(MainWindowController.zoomOut(_:)), "-"),
            .separator(),
            item("Open in Browser", #selector(MainWindowController.openInBrowser(_:)), "o", [.command, .shift]),
        ]))
        main.addItem(submenu("Recording", [
            item(presentation.toggleTitle, actions.toggle, target: actions.target),
            item("Sync now", actions.shipNow, target: actions.target),
        ]))
        for entry in [item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
                      item("Close", #selector(NSWindow.performClose(_:)), "w")] { windows.addItem(entry) }
        let windowItem = NSMenuItem(title: "Window", action: nil, keyEquivalent: "")
        windowItem.submenu = windows
        main.addItem(windowItem)
        main.addItem(submenu("Help", [item("Lifestream Tour", #selector(Tour.show(_:)), target: actions.tour),
                                      item("Send Feedback…", #selector(Feedback.send(_:)), target: actions.feedback)]))
        return main
    }

    static func recordingToggle(in main: NSMenu) -> NSMenuItem? {
        main.item(withTitle: "Recording")?.submenu?.items.first
    }

    private static func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
        let menu = NSMenu(title: title)
        items.forEach(menu.addItem)
        let entry = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        entry.submenu = menu
        return entry
    }

    private static func item(_ title: String, _ action: Selector, _ key: String = "",
                             _ modifiers: NSEvent.ModifierFlags = [.command], target: AnyObject? = nil) -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
        entry.keyEquivalentModifierMask = modifiers
        entry.target = target
        return entry
    }
}
