#if os(macOS)
import Cockpit
import SwiftUI

@MainActor let agentRequestSheet = Sheet("agent-request", hosted: true, platforms: [.ios, .mac]) {
    Specimen("A sign-in from its site, the default access") {
        AgentRequestCard(head: "Claude wants to read your Lifestream", line: "From claude.ai", pickTitle: "Type the code Claude shows", pickLine: "The code is the yes. A wrong one turns Claude away.", sentence: agentSentence, change: {}) { _ in }
    }
    Specimen("After Edit") {
        AgentRequestCard(head: "Hermes wants to read your Lifestream", line: "Signing in from hermes.example.com · 10:52", pickTitle: "Type the code Hermes shows", pickLine: "The code is the yes. A wrong one turns Hermes away.",
                         sentence: "Hermes will read Mail and Calendar from the past 30 days. Names visible, other details hidden.",
                         change: {}) { _ in }
    }
    Specimen("A name of two lines") {
        AgentRequestCard(head: "Hermes from claude.ai wants to read your Lifestream", line: "Signing in from hermes.example.com · 10:52", pickTitle: "Type the code Hermes from claude.ai shows", pickLine: "The code is the yes. A wrong one turns Hermes from claude.ai away.") { _ in }
    }
    Specimen("An app on the computer signing in") {
        AgentRequestCard(head: "Claude Code wants to read your Lifestream", line: "Signing in · 10:52", pickTitle: "Type the code Claude Code shows", pickLine: "The code is the yes. A wrong one turns Claude Code away.") { _ in }
    }
    Specimen("A pick on its way") {
        AgentRequestCard(head: "Claude wants to read your Lifestream", line: "From claude.ai", pickTitle: "Type the code Claude shows", pickLine: "The code is the yes. A wrong one turns Claude away.", sending: .code("482915")) { _ in }
    }
    Specimen("A pick that did not reach the home") {
        AgentRequestCard(head: "Claude wants to read your Lifestream", line: "From claude.ai", pickTitle: "Type the code Claude shows", pickLine: "The code is the yes. A wrong one turns Claude away.",
                         failed: "This didn't reach Lifestream. Tap again.") { _ in }
    }
    Specimen("Allowed: the home's words, and Done") {
        AgentRequestCard(head: "Claude wants to read your Lifestream", line: "From claude.ai", pickTitle: "Type the code Claude shows", pickLine: "The code is the yes. A wrong one turns Claude away.", sentence: agentSentence, change: {},
                         ended: .init("Claude wants to read your Lifestream", words: "Allowed on iPhone, 09:00")) { _ in }
    }
    Specimen("Don't allow: the home's words, and Done") {
        AgentRequestCard(head: "Claude wants to read your Lifestream", line: "From claude.ai", pickTitle: "Type the code Claude shows", pickLine: "The code is the yes. A wrong one turns Claude away.", sentence: agentSentence, change: {},
                         ended: .init("Claude wants to read your Lifestream", words: "Not allowed on iPhone, 09:00")) { _ in }
    }
    Specimen("A number not the page's: the home's words, and Done") {
        AgentRequestCard(head: "Claude wants to read your Lifestream", line: "From claude.ai", pickTitle: "Type the code Claude shows", pickLine: "The code is the yes. A wrong one turns Claude away.", sentence: agentSentence, change: {},
                         ended: .init("Claude wants to read your Lifestream", words: "Wrong number, so Claude wasn\u{2019}t let in. Start the sign-in again in Claude.")) { _ in }
    }
    Specimen("Ended before the tap: the home's words, and Done") {
        AgentRequestCard(head: "Claude wants to read your Lifestream", line: "From claude.ai", pickTitle: "Type the code Claude shows", pickLine: "The code is the yes. A wrong one turns Claude away.", sentence: agentSentence, change: {},
                         ended: .init("Claude wants to read your Lifestream", words: "This sign-in is over. Start it again in claude.ai.")) { _ in }
    }
    Specimen("At an accessibility size") {
        AgentRequestCard(head: "ChatGPT wants to read your Lifestream", line: "Signing in from chatgpt.com · 10:52", pickTitle: "Type the code ChatGPT shows", pickLine: "The code is the yes. A wrong one turns ChatGPT away.") { _ in }
            .environment(\.dynamicTypeSize, .accessibility3)
    }
}

private let agentSentence = "Claude will read everything except Health and Money, and sources you add later. Names visible, other details hidden."

private let forAnHour: [AgentAskCard.Choice] = [.init(.once, "For 1 hour"), .init(.always, "Always"), .init(.no, "No")]

@MainActor let agentAskSheet = Sheet("agent-ask", hosted: true, platforms: [.ios, .mac]) {
    Specimen("A source, for a time") {
        AgentAskCard(name: "Instinct", when: "10:31 · 1 of 2", head: "Instinct wants all of WhatsApp for 1 hour.", fact: "Your WhatsApp accounts of today.",
                     reason: "Sam moved Saturday's dinner in a WhatsApp chat last week. I need the new time to update your plan.",
                     choices: forAnHour, preferred: .once, change: {}) { _ in }
    }
    Specimen("One account, by name, turning the screen on") {
        AgentAskCard(head: "ChatGPT wants your work Gmail for 1 hour.", fact: "person-a@work.example.com",
                     reason: "The Q4 plan you asked about was sent to your work address, not your personal one.",
                     screen: "Whatever was on your screen, so close to everything.",
                     choices: forAnHour, preferred: .once, change: {}) { _ in }
    }
    Specimen("What it asked for, erased since: No alone") {
        AgentAskCard(head: "Instinct wants something since erased.", reason: "Email addresses, to write back.",
                     choices: [.init(.no, "No")], preferred: .always,
                     failed: "What this request asked for was erased since: it can only be dismissed.", change: nil) { _ in }
    }
    Specimen("An answer on its way") {
        AgentAskCard(head: "Instinct wants all of WhatsApp for 1 hour.", reason: "I need the new time.", choices: forAnHour,
                     preferred: .once, sending: .once, change: {}) { _ in }
    }
    Specimen("An answer that did not reach the home") {
        AgentAskCard(head: "Instinct wants all of WhatsApp for 1 hour.", reason: "I need the new time.", choices: forAnHour,
                     preferred: .once, failed: "This didn't reach Lifestream. Tap again.", change: {}) { _ in }
    }
    Specimen("Allowed") {
        AgentAskCard(name: "Instinct", when: "10:32", head: "Asks for all of WhatsApp for 1 hour", reason: nil, choices: forAnHour,
                     preferred: .once, outcome: "Allowed on iPhone, 09:00", change: {}) { _ in }
    }
    Specimen("At an accessibility size") {
        AgentAskCard(head: "Instinct wants all of WhatsApp for 1 hour.", reason: "I need the new time.", choices: forAnHour,
                     preferred: .once, change: {}) { _ in }
            .environment(\.dynamicTypeSize, .accessibility3)
    }
}

@MainActor let accessFootSheet = Sheet("access-foot", hosted: true, platforms: [.ios, .mac]) {
    Specimen("Nothing waits: where to start from") {
        AccessFoot { startFrom }
    }
    Specimen("A narrowing, saved at once, with Undo") {
        AccessFoot("Claude no longer reads Messages.", answer: .undo({})) { startFrom }
    }
    Specimen("A widening waits for Allow") {
        AccessFoot("Claude would also read Health.", answer: .allow(cancel: {}, allow: {})) { startFrom }
    }
    Specimen("A widening on its way") {
        AccessFoot("Claude would also read Health.", answer: .allow(cancel: {}, allow: {}), busy: true)
    }
    Specimen("A widening, the home's words not yet served") {
        AccessFoot(answer: .allow(cancel: {}, allow: {})) { startFrom }
    }
}

@MainActor private var startFrom: some View {
    Button("Start from") {}.buttonStyle(.cockpit(.plain))
}
#endif
