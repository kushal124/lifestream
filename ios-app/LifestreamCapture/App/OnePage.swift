import Cockpit
import LifestreamCaptureCore
import SwiftUI

struct OnePage<Content: View>: View {
    let name: String
    let inBar: Bool
    let content: Content

    init(_ name: String, inBar: Bool = false, @ViewBuilder content: () -> Content) {
        self.name = name
        self.inBar = inBar
        self.content = content()
    }

    var body: some View {
        let page = ScrollView {
            VStack(alignment: .leading, spacing: Cockpit.Gap.section) {
                content
            }
            .padding(.horizontal, Cockpit.Gap.edge)
            .padding(.vertical, Cockpit.Gap.head)
        }
        .groundColor(Cockpit.Color.canvas)
        if inBar {
            page.navigationTitle(name).navigationBarTitleDisplayMode(.inline)
        } else {
            page.barTitle(name)
        }
    }
}

struct OneHead<Face: View>: View {
    let name: String
    let line: [PartLine.Part]
    let quiet: Bool
    let identifier: String
    let done: HeadDone?
    let face: Face

    init(_ name: String, parts: [PartLine.Part], quiet: Bool = false, identifier: String,
         done: HeadDone? = nil, @ViewBuilder face: () -> Face) {
        self.name = name
        self.line = parts
        self.quiet = quiet
        self.identifier = identifier
        self.done = done
        self.face = face()
    }

    init(_ name: String, line: String, quiet: Bool = false, identifier: String,
         done: HeadDone? = nil, @ViewBuilder face: () -> Face) {
        self.init(name, parts: line.isEmpty ? [] : line.components(separatedBy: " · ").map { PartLine.Part($0) },
                  quiet: quiet, identifier: identifier, done: done, face: face)
    }

    private var centred: Bool { Face.self != EmptyView.self }

    var body: some View {
        VStack(alignment: centred ? .center : .leading, spacing: Cockpit.Gap.inRow) {
            if centred {
                face
                    .padding(.bottom, Cockpit.Space.s2)
            }
            Text(name)
                .cockpit(.title1)
                .foregroundStyle(quiet ? Cockpit.Color.textSecondary : Cockpit.Color.text)
                .multilineTextAlignment(centred ? .center : .leading)
                .lineLimit(3)
                .minimumScaleFactor(0.75)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier(identifier)
                .fadesIntoBar()
            if let done {
                done
            } else if !line.isEmpty {
                PartLine(line)
                    .cockpitLines(1)
                    .frame(maxWidth: 320, alignment: centred ? .center : .leading)
                    .accessibilityIdentifier("page.line")
            }
        }
        .frame(maxWidth: .infinity, alignment: centred ? .center : .leading)
    }
}

struct AboutCard: View {
    let facts: [HeadFact]
    @Environment(\.openURL) private var openURL

    var body: some View {
        if !facts.isEmpty {
            Card("About", group: true, flat: true) {
                KeyValueRows {
                    ForEach(Array(facts.enumerated()), id: \.element.id) { index, fact in
                        KeyValueRow(fact.key, fact.words, separator: index < facts.count - 1, outward: fact.link != nil,
                                    action: fact.link.map { link in { openURL(link) } })
                            .accessibilityLabel(fact.said ?? "\(fact.key), \(fact.words)")
                            .accessibilityRemoveTraits(fact.link == nil ? [] : .isButton)
                            .accessibilityAddTraits(fact.link == nil ? [] : .isLink)
                            .accessibilityIdentifier("page.fact.\(fact.id)")
                    }
                }
            }
        }
    }
}

struct HeadDone: View {
    enum Act {
        case undo, again, check

        var words: String {
            switch self {
            case .undo: "Undo"
            case .again: "Try Again"
            case .check: "Check"
            }
        }
    }

    let words: String
    let press: (() -> Void)?
    var act = Act.undo
    var busy = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(press == nil ? words : words + Words.dot)
                .cockpit(.subhead)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("page.done")
            if let press {
                Button(action: press) {
                    Text(act.words)
                        .cockpit(.subhead)
                        .fontWeight(.semibold)
                        .foregroundStyle(busy ? Cockpit.Color.textTertiary : Cockpit.Color.text)
                        .padding(Cockpit.Space.s3)
                        .contentShape(Rectangle())
                        .padding(-Cockpit.Space.s3)
                }
                .buttonStyle(.plain)
                .disabled(busy)
                .accessibilityIdentifier(act == .undo ? "page.undo" : "page.retry")
            }
        }
    }
}

struct HeadFact: Identifiable {
    let id: String
    let key: String
    let words: String
    var link: URL?
    var said: String?
}

extension OneHead where Face == EmptyView {
    init(_ name: String, parts: [PartLine.Part], identifier: String) {
        self.init(name, parts: parts, identifier: identifier) { EmptyView() }
    }
}

struct OneTile: View {
    let icon: Cockpit.Icon

    var body: some View {
        Icon(icon, size: .lg)
            .foregroundStyle(Cockpit.Color.textSecondary)
            .frame(width: 72, height: 72)
            .background(Circle().fill(Cockpit.Color.raised))
            .accessibilityHidden(true)
    }
}

struct Facts: View {
    let label: String?
    let facts: [(String, String)]
    let reading: Bool

    init(_ label: String?, _ facts: [(String, String)], reading: Bool = false) {
        self.label = label
        self.facts = facts
        self.reading = reading
    }

    var body: some View {
        if !facts.isEmpty {
            Card(label, group: true) {
                KeyValueRows {
                    ForEach(facts.indices, id: \.self) { index in
                        KeyValueRow(facts[index].0, facts[index].1, separator: index < facts.count - 1)
                    }
                }
            }
            .reading(reading)
        }
    }
}

struct Offer: View {
    let icon: Cockpit.Icon
    let name: String
    let line: String
    let button: String
    let primary: Bool
    let identifier: String
    let action: () -> Void

    var body: some View {
        Card {
            HStack(spacing: Cockpit.Space.s4) {
                Icon(icon, size: .md)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .frame(width: Cockpit.Platform.ios.iconColumn)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .cockpit(.rowTitle)
                        .foregroundStyle(Cockpit.Color.text)
                    Text(line)
                        .cockpit(.subhead)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button(button, action: action)
                    .buttonStyle(.cockpit(primary ? .primary : .secondary))
                    .accessibilityIdentifier(identifier)
            }
        }
    }
}
