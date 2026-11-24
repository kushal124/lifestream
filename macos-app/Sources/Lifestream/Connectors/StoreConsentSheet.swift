import Cockpit
import HomeLink
import Shipping
import SwiftUI

@MainActor enum StoreConsentSheets {
    static var stores: DeclaredStores?
    nonisolated static let grantPrefix = "store:"
}

struct StoreConsentSheet: View {
    let host: MacHost
    let asking: StoreAsking
    let name: String
    @State private var refusal: String?

    var body: some View {
        SheetFrame("Allow \(name) on this Mac?", line: "A connector in Lifestream asks this Mac to read these files.") {
            SheetPart("Files", note: asking.new.isEmpty ? nil : "New since you last allowed it are marked.") {
                VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                    ForEach(asking.paths, id: \.self) { path in
                        Text(asking.new.contains(path) ? "\(path)  (new)" : path)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                    }
                }
            }
            if let wake = asking.wake {
                SheetPart("Opens") {
                    Text("\(wake), hidden, before each read").quiet(.body)
                }
            }
            if !asking.sql.isEmpty {
                DisclosureGroup("The SQL it runs") {
                    VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                        ForEach(Array(asking.sql.enumerated()), id: \.offset) { _, sql in
                            Text(sql).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        }
                    }
                }
            }
            if let refusal { InPlaceLine(refusal) }
        } acts: {
            Button("Don't Allow") { answer(.refused) }.buttonStyle(.cockpit(.plain)).keyboardShortcut(.cancelAction)
            Button("Allow") { answer(.allowed) }.buttonStyle(.cockpit(.primary))
        }
    }

    private func answer(_ answer: StoreConsent.Answer) {
        refusal = host.answerStore(answer, to: asking)
    }
}
