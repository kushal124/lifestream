#if os(macOS)
import SwiftUI
@testable import Cockpit

@MainActor let buttonSheet = Sheet("button", ios: 430, mac: 420) {
    Specimen("Primary · secondary · plain") {
        HStack(spacing: 8) {
            Button("Open day") {}.buttonStyle(.cockpit(.primary))
            Button("Not now") {}.buttonStyle(.cockpit(.secondary))
            Button("Copy") {}.buttonStyle(.cockpit(.plain))
        }
    }
    Specimen("Caution and warning tones") {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Button("Fix") {}.buttonStyle(.cockpit(.primary, tone: .caution))
                Button("Allow") {}.buttonStyle(.cockpit(.secondary, tone: .caution))
                Button("Later") {}.buttonStyle(.cockpit(.plain, tone: .caution))
            }
            HStack(spacing: 8) {
                Button("Delete this note") {}.buttonStyle(.cockpit(.primary, tone: .warning))
                Button("Stop") {}.buttonStyle(.cockpit(.secondary, tone: .warning))
                Button("Remove") {}.buttonStyle(.cockpit(.plain, tone: .warning))
            }
        }
    }
    Specimen("Sizes: large · regular · small (Mac: one size)") {
        HStack(spacing: 8) {
            Button("Continue") {}.buttonStyle(.cockpit(.primary, size: .large))
            Button("Pair") {}.buttonStyle(.cockpit(.secondary))
            Button("Fix") {}.buttonStyle(.cockpit(.secondary, size: .small))
        }
    }
    Specimen("With an icon") {
        HStack(spacing: 8) {
            Button { } label: { Icon(.add); Text("Add a note") }.buttonStyle(.cockpit(.primary))
            Button { } label: { Text("Open day"); Icon(.forward) }.buttonStyle(.cockpit(.secondary, size: .small))
        }
    }
    Specimen("With its shortcut: primary with an icon · secondary · plain · busy") {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Button { } label: { Icon(.ai); Text("Ask") }.buttonStyle(.cockpit(.primary, key: "⌘⏎"))
                Button("Open day") {}.buttonStyle(.cockpit(.secondary, key: "⌘O"))
            }
            HStack(spacing: 8) {
                Button("Copy") {}.buttonStyle(.cockpit(.plain, key: "⌘C"))
                Button { } label: { Icon(.ai); Text("Ask") }.buttonStyle(.cockpit(.primary, busy: true, key: "⌘⏎")).environment(\.skeletonForced, 0.3)
            }
        }
    }
    Specimen("States: hover · pressed · disabled · busy") {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Button("Hover") {}.buttonStyle(set(CockpitButtonStyle.cockpit(.secondary), \.forced, .hover))
                Button("Pressed") {}.buttonStyle(set(CockpitButtonStyle.cockpit(.secondary), \.forced, .pressed))
                Button("Hover") {}.buttonStyle(set(CockpitButtonStyle.cockpit(.primary), \.forced, .hover))
                Button("Pressed") {}.buttonStyle(set(CockpitButtonStyle.cockpit(.primary), \.forced, .pressed))
            }
            HStack(spacing: 8) {
                Button("Hover") {}.buttonStyle(set(CockpitButtonStyle.cockpit(.plain), \.forced, .hover))
                Button("Pressed") {}.buttonStyle(set(CockpitButtonStyle.cockpit(.plain), \.forced, .pressed))
            }
            HStack(spacing: 8) {
                Button("Off") {}.buttonStyle(.cockpit(.secondary)).disabled(true)
                Button("Saving") {}.buttonStyle(.cockpit(.secondary, busy: true)).environment(\.skeletonForced, 0.3)
                Button("Off") {}.buttonStyle(.cockpit(.primary)).disabled(true)
                Button("Saving") {}.buttonStyle(.cockpit(.primary, busy: true)).environment(\.skeletonForced, 0.3)
            }
        }
    }
    Specimen("Full width") {
        Button("Pair with Lifestream") {}.buttonStyle(.cockpit(.primary, size: .large, fullWidth: true))
    }
}

@MainActor let iconButtonSheet = Sheet("icon-button") {
    Specimen("Glass over content (drawn glass; iOS 26 and macOS 26 draw the system's)") {
        ZStack {
            LinearGradient(colors: [Color(white: 0.55), Color(white: 0.15), Color(white: 0.8)], startPoint: .topLeading, endPoint: .bottomTrailing)
            HStack(spacing: 12) {
                IconButton(.add, label: "Add", style: .glass) {}
                IconButton(.search, label: "Search", style: .glass) {}
                IconButton(.more, label: "More", style: .glass, size: .small) {}
            }
        }
        .frame(height: 88)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .environment(\.cockpitSystemGlass, false)
    }
    Specimen("Reduce Transparency") {
        HStack(spacing: 12) {
            IconButton(.add, label: "Add", style: .glass) {}
            IconButton(.search, label: "Search", style: .glass) {}
        }
        .environment(\._accessibilityReduceTransparency, true)
    }
    Specimen("Raised on a card · plain") {
        Card {
            HStack(spacing: 12) {
                IconButton(.back, label: "Previous day", style: .raised) {}
                IconButton(.forward, label: "Next day", style: .raised) {}
                IconButton(.share, label: "Share", style: .plain) {}
                IconButton(.close, label: "Close", style: .plain, size: .small) {}
            }
        }
    }
    Specimen("States: hover · pressed · disabled") {
        HStack(spacing: 12) {
            forcedIcon(.hover, .raised)
            forcedIcon(.pressed, .raised)
            IconButton(.sidebar, label: "Sidebar", style: .raised) {}.disabled(true)
            forcedIcon(.hover, .plain)
            forcedIcon(.pressed, .plain)
        }
    }
}

@MainActor private func forcedIcon(_ state: ButtonState, _ style: IconButton.Style) -> some View {
    var button = IconButton(.sidebar, label: "Sidebar", style: style) {}
    button.forced = state
    return button
}

@MainActor let tagSheet = Sheet("tag") {
    Specimen("Neutral · mono") {
        HStack(spacing: 6) {
            Tag("WhatsApp")
            Tag("+1 555 0000 001", mono: true)
            Tag("person-a@example.com", mono: true)
        }
    }
    Specimen("Signal tones") {
        HStack(spacing: 6) {
            Tag("Live", tone: .engaged)
            Tag("Off", tone: .idle)
            Tag("Today", tone: .now)
            Tag("Planned", tone: .plan)
        }
        HStack(spacing: 6) {
            Tag("Needs you", tone: .caution)
            Tag("Stopped", tone: .warning)
        }
    }
}

@MainActor let needsRowSheet = Sheet("needs-row", hosted: true, platforms: [.ios]) {
    Specimen("Needs you: the mark, the sentence, its act") {
        Card("Needs you", group: true) {
            ListRow("Sign in to GitHub again", leading: .signal(.caution, word: "Needs you"),
                    control: .act("Sign in", busy: false), action: {})
            ListRow("Tailscale is off on this iPhone", meta: "Last reached 14:02", leading: .signal(.warning, word: "Stopped"),
                    control: .act("View details", busy: false), action: {})
            ListRow("Google's export broke", leading: .signal(.warning, word: "Stopped"),
                    control: .act("Try again", busy: false), action: {})
            ListRow("Claude can read a second account", leading: .signal(.caution, word: "Needs you"), action: {})
            ListRow("This build stops working on 12 November", meta: "Reinstall it from your Mac.",
                    leading: .signal(.caution, word: "Needs you"), separator: false)
        }
    }
    Specimen("Pressed · busy") {
        Card(group: true) {
            pressedNeed
            ListRow("Your WhatsApp export is in", leading: .signal(.caution, word: "Needs you"), separator: false,
                    control: .act("Skip it", busy: true))
        }
    }
    Specimen("Long") {
        Card(group: true) {
            ListRow("Lifestream needs Full Disk Access to read Messages and Notes on your Mac",
                    meta: "Open System Settings, Privacy and Security, Full Disk Access, and switch on Lifestream.",
                    leading: .signal(.caution, word: "Needs you"), separator: false,
                    control: .act("Open", busy: false), action: {})
        }
    }
}

@MainActor private var pressedNeed: some View {
    var row = ListRow("Photos access is limited", leading: .signal(.caution, word: "Needs you"),
                      control: .act("Allow", busy: false), action: {})
    row.forced = .pressed
    return row
}

@MainActor let figureSheet = Sheet("figure", ios: 390, mac: 560) {
    Specimen("xl · l · m") {
        HStack(alignment: .top, spacing: 24) {
            Figure("7,412", label: "Steps", size: .xl)
            Figure("5h 50m", label: "Asleep", size: .l)
            Figure("14", label: "People", size: .m)
        }
    }
    Specimen("The day's strip, Asleep selected") {
        FigureStrip {
            Figure("5h 50m", label: "Asleep", selected: true) {}
            Figure("7,412", label: "Steps") {}
            Figure("3", label: "Places") {}
            Figure("14", label: "People") {}
            Figure("9h 10m", label: "Mac") {}
            Figure("2h 4m", label: "Phone") {}
        }
    }
    Specimen("States: hover · pressed") {
        HStack(spacing: 12) {
            forcedFigure(.hover)
            forcedFigure(.pressed)
        }
    }
    Specimen("A person's figures, large values") {
        FigureStrip {
            Figure("12,480", label: "Messages")
            Figure("1", label: "Calls")
            Figure("1,204", label: "Days in touch")
            Figure("Mar 2019", label: "Since")
        }
    }
}

@MainActor private func forcedFigure(_ state: ButtonState) -> some View {
    var figure = Figure("7,412", label: "Steps") {}
    figure.forced = state
    return figure
}

@MainActor let meterSheet = Sheet("meter") {
    Card {
        VStack(spacing: 14) {
            Meter("Xcode", value: "2h 14m", share: 1)
            Meter("Safari", value: "1h 2m", share: 0.46, step: 2)
            Meter("Messages", value: "21m", share: 0.16, step: 3)
            Meter("Notes", value: "4m", share: 0.03, step: 4)
            Meter("Terminal", value: "0m", share: 0)
            Meter("A very long application name that does not fit on the narrow phone", value: "1m", share: 0.008)
        }
    }
    Specimen("Progress: how far a run has come, in here") {
        VStack(spacing: 14) {
            Meter("42 organised · 120 more you talk to often", value: "", share: 42.0 / 162, progress: true)
            Meter("4,210 of 22,700 photos", value: "Newest first", share: 4210.0 / 22700, progress: true)
        }
    }
}

@MainActor let emptyStateSheet = Sheet("empty-state") {
    Specimen("With a button") {
        Card { EmptyState(.people, "No one to show yet. People appear as your messages and calls are read.", action: "Open Connectors") }
    }
    Specimen("Sentence only") {
        Card { EmptyState(.search, "Nothing matches \u{201C}lyon\u{201D} in October.") }
    }
    Specimen("NoneLine: a list that holds none, where its rows would stand; with a second line") {
        VStack(alignment: .leading, spacing: Cockpit.Space.s6) {
            NoneLine("No other calls this week.")
            NoneLine("Nothing was recorded this day.", detail: "This iPhone was off from 02:10.")
        }
    }
}

@MainActor let copyValueSheet = Sheet("copy-value") {
    Specimen("A code") { CopyValue("WDJB-MJHT", shape: "XXXX-XXXX", label: "Your code", copy: { _ in }) }
    Specimen("A line, wrapping") {
        CopyValue("Lifestream runs on this Mac. Run ~/.local/bin/lifestream help connectors and follow it to add a connector for Obsidian; type each lifestream command it names as ~/.local/bin/lifestream.",
                  shape: "", label: "Line for your coding agent", line: true, copy: { _ in })
    }
    Specimen("None yet: its shape, the button unseen") { CopyValue(nil, shape: "XXXX-XXXX", label: "Your code", copy: { _ in }) }
    Specimen("A code that runs out, its page under it") {
        VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
            HStack(spacing: Cockpit.Space.s2) {
                CopyValue("WDJB-MJHT", shape: "XXXX-XXXX", label: "Your code", copy: { _ in })
                Button("New code") {}.buttonStyle(.cockpit(.plain))
            }
            Text("Or go to [auth.example.com/device](https://auth.example.com/device)")
                .cockpit(.footnote).foregroundStyle(Cockpit.Color.textSecondary).tint(Cockpit.Color.text)
        }
    }
    Specimen("Run out: New code the one action") {
        HStack(spacing: Cockpit.Space.s2) {
            CopyValue(nil, shape: "XXXX-XXXX", label: "Your code", copy: { _ in })
            Button("New code") {}.buttonStyle(.cockpit(.primary))
        }
    }
}

#endif
