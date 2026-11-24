#if os(macOS)
import SwiftUI
@testable import Cockpit


@MainActor let severitySheet = Sheet("severity", ios: 390, mac: 460) {
    Specimen("Stopped, needs you, waiting, done: the shape alone, in its colour") {
        VStack(alignment: .leading, spacing: 10) {
            ForEach([CGFloat(14), 16, 18, 20], id: \.self) { size in
                HStack(spacing: 14) {
                    ForEach(Cockpit.Severity.allCases, id: \.self) { SeverityMark($0, size: size) }
                    Text("\(Int(size))").cockpit(.caption).foregroundStyle(Cockpit.Color.textTertiary)
                }
            }
        }
    }
}

@MainActor let statusStripSheet = Sheet("status-strip", ios: 390, mac: 460) {
    Specimen("Unreachable, a cause of the device's own (off the Mac's Wi-Fi; Lifestream not running)") { Strip(.own) }
    Specimen("Unreachable: offline, Tailscale off") {
        VStack(spacing: 8) {
            Strip(.offline)
            Strip(.tailscaleOff)
        }
    }
    Specimen("Unreachable: no answer; the clock on another day; the details' chevron, no act") {
        StatusStrip(.stopped, title: "Can't reach Lifestream", line: "Your Mac isn't answering", since: "since Sat 14 Nov", details: {})
    }
    Specimen("Held: the door's title and line, its act at the end; then pressed and not yet answered") {
        VStack(spacing: 8) {
            StatusStrip(.stopped, title: "Lifestream is held", line: "The drive holding it went away.", since: "since 14:02",
                        act: .init("Check again") {})
            StatusStrip(.stopped, title: "Lifestream is held", line: "The drive holding it went away.", since: "since 14:02",
                        act: .init("Check again", busy: true) {})
        }
    }
    Specimen("An update: the home's, this device's; no clock, the home answering at every probe") {
        VStack(spacing: 8) {
            StatusStrip(.needs, title: "Lifestream needs its update", line: "Update Lifestream on your Mac")
            Named { device in StatusStrip(.needs, title: "Update Lifestream on this \(device)", line: "Nothing is lost meanwhile") }
        }
    }
    Specimen("A pass the home does not know: Pair") {
        Named { device in
            StatusStrip(.needs, title: "Pair this \(device) again", line: "Lifestream no longer knows it", act: .init("Pair") {})
        }
    }
    Specimen("The Mac unpaired: no clock, no act") {
        StatusStrip(.needs, title: "This Mac isn't paired", line: "Open Lifestream to set it up")
    }
    Specimen("Starting, then reached again") {
        VStack(spacing: 8) {
            StatusStrip(.waiting, title: "Lifestream is starting", line: "It answers in a moment.")
            StatusStrip(.done, title: "Reached Lifestream", line: "Read again at 13:02")
        }
    }
    Specimen("A need of this device's own, long, read whole") {
        StatusStrip(.needs, title: "Lifestream needs Full Disk Access to read Messages and Notes on this Mac",
                    line: "Open System Settings, Privacy and Security, Full Disk Access, and switch on Lifestream.",
                    act: .init("Allow") {})
    }
}

@MainActor let pathChecklistSheet = Sheet("path-checklist", platforms: [.ios]) {
    Specimen("Tailscale off: the broken link's fix and its act") {
        PathChecklist("Can't reach Lifestream", line: "Last reached 12:55", links: [
            .init("online", name: "This iPhone online", state: .passed, value: "Connected"),
            .init("tailscale", name: "Tailscale on this iPhone", state: .failed, value: "Off",
                  fix: "Turn it on, or join your Mac's Wi\u{2011}Fi", act: .init("Open") {}),
            .init("mac", name: "Your Mac", state: .unchecked, value: "Not checked"),
        ], retry: .init("Try again") {}, close: {})
        .frame(height: 380, alignment: .top)
    }
    Specimen("The home silent; Try again pressed") {
        PathChecklist("Can't reach Lifestream", line: "Last reached Sat 14 Nov · 14:02", links: [
            .init("online", name: "This iPhone online", state: .passed, value: "Connected"),
            .init("tailscale", name: "Tailscale on this iPhone", state: .passed, value: "On"),
            .init("mac", name: "Your Mac", state: .failed, value: "Not answering",
                  fix: "Check that it's awake, on the same Wi\u{2011}Fi or on Tailscale"),
        ], retry: .init("Try again", busy: true) {})
        .frame(height: 380, alignment: .top)
    }
}

@MainActor let pageLackSheet = Sheet("page-lack") {
    Specimen("Failed for reach: what the page lacks, nothing to press") { PageLack("This day isn't on this iPhone yet.") }
    Specimen("Failed of itself: Try again") { PageLack("This day couldn't be read.", retry: {}) }
    Specimen("Refused: the home's own words") { PageLack("Lifestream holds no such day.") }
    Specimen("Long") {
        PageLack("Everyone you talk with is read from Lifestream, and none of them is on this iPhone yet.", retry: {})
    }
    Specimen("A page while reach lacks: the strip says why, the page what it lacks") {
        VStack(alignment: .leading, spacing: 8) {
            Strip(.silent)
            PageLack("This day isn't on this iPhone yet.")
        }
    }
}

@MainActor let inPlaceLineSheet = Sheet("in-place-line") {
    Specimen("Not sent: it never reached the home, or the home failed it") { InPlaceLine(.notSent, retry: {}) }
    Specimen("Refused: the home's words") { InPlaceLine(.refused("That isn't a day."), retry: {}) }
    Specimen("Still saving: begun on the home, no answer yet, the waiting mark, Check sends it again") {
        InPlaceLine(.saving("Still saving to Lifestream"), retry: {})
    }
    Specimen("Not known: the home's words, the needs-you mark, no Try again") {
        InPlaceLine(.unknown("Lifestream didn't say whether this was done."), retry: {})
    }
    Specimen("The place's own failure, its act named") {
        InPlaceLine("The microphone is off for Lifestream.", act: "Open Settings", retry: {})
    }
    Specimen("Needs you: Chat still answers, on another plan than the one picked") {
        InPlaceLine("Your pick needs your Claude sign-in on your Mac. Asking GPT-6.1 Terra.", severity: .needs)
    }
    Specimen("Long, in a card, under the switch it answers") {
        Card {
            VStack(alignment: .leading, spacing: 0) {
                ListRow("Spam and Trash", meta: "Kept with the rest of your mail", separator: false)
                InPlaceLine("Not saved: Lifestream didn't answer, and what you changed is still on this device.", retry: {})
            }
        }
    }
    Specimen("An act's outcome: running, the act busy; failed, the line under the act, its way out the act") {
        Card {
            VStack(alignment: .leading, spacing: 0) {
                ListRow("Build an export", separator: false) { Spinner() }
                    .actOutcome(.running, retry: {})
                ListRow("Build an export", separator: false)
                    .actOutcome(.failed(.refused("This phone couldn't build the export.")), retry: {})
            }
        }
    }
    Specimen("Done: the button that did it says so, then is itself again") {
        HStack(spacing: 16) {
            Button("Save") {}.buttonStyle(.cockpit(.plain)).cockpitDone("Saved")
            Button("Save") {}.buttonStyle(.cockpit(.secondary)).cockpitDone("Saved")
            Button("Save") {}.buttonStyle(.cockpit(.primary))
        }
    }
}

@MainActor let reachWaitSheet = Sheet("reach-wait") {
    Specimen("Past patience: a wait of this read alone, the door's words") {
        VStack(alignment: .leading, spacing: 0) {
            rows
            waited(words: "The search index is busy. Try again in a moment.")
        }
        .reading(true)
        .environment(\.skeletonForced, 0)
    }
    Specimen("Reach lacks: the line hidden, the page's lack in its place") {
        VStack(alignment: .leading, spacing: 0) {
            rows
            waited()
            PageLack("Your streams aren't on this Mac yet.")
        }
        .reading(true)
        .environment(\.skeletonForced, 0)
        .environment(\.reachLacks, true)
    }
    Specimen("A page's mark past patience, with a wait's words") {
        loading(words: "Chat isn't answering on your Mac").frame(height: 200)
    }
    Specimen("A page's mark while reach lacks: nothing, the lack in its place") {
        VStack(spacing: 0) {
            loading()
            PageLack("The people you talk with aren't read yet.")
        }
        .environment(\.reachLacks, true)
    }
}

private struct Strip: View {
    enum Cause { case offline, tailscaleOff, own, silent }

    let cause: Cause
    @Environment(\.cockpitPlatform) private var platform

    init(_ cause: Cause) {
        self.cause = cause
    }

    var body: some View {
        let ios = platform == .ios
        let line = switch cause {
        case .offline: "This \(ios ? "iPhone" : "Mac") is offline"
        case .tailscaleOff: "Tailscale is off"
        case .own: ios ? "Not on your Mac's Wi\u{2011}Fi" : "Lifestream isn't running"
        case .silent: ios ? "Your Mac isn't answering" : "Lifestream isn't answering"
        }
        StatusStrip(.stopped, title: "Can't reach Lifestream", line: line, since: "since 14:02",
                    act: ios ? .init("Try again") {} : cause == .own ? .init("Open Lifestream") {} : nil, details: {})
    }
}

private struct Named<Content: View>: View {
    let content: (String) -> Content
    @Environment(\.cockpitPlatform) private var platform

    init(@ViewBuilder _ content: @escaping (String) -> Content) {
        self.content = content
    }

    var body: some View { content(platform == .ios ? "iPhone" : "Mac") }
}

@MainActor private func waited(words: String? = nil) -> WaitLine {
    var line = WaitLine(words: words)
    line.forced = true
    return line
}

@MainActor private func loading(words: String? = nil) -> Loading {
    var loading = Loading("Reading", words: words)
    loading.forced = 0.5
    loading.forcedWaiting = true
    return loading
}

@MainActor private var rows: some View {
    Card("Conversations", group: true) {
        ListRow("iMessage", meta: "29 messages today", mono: true, leading: .symbol(.message), action: {})
        ListRow("WhatsApp", meta: "140 messages today", mono: true, leading: .symbol(.message), separator: false, action: {})
    }
}
#endif
