import Cockpit
import SwiftUI

struct NeedsList: View {
    @ObservedObject var needs: NeedsModel
    let press: (Need, Need.Button) -> Void

    var body: some View {
        VStack(spacing: Cockpit.Space.s2) {
            ForEach(needs.list) { need in NeedStrip(needs: needs, need: need, press: press) }
        }
    }
}

struct NeedStrip: View {
    @ObservedObject var needs: NeedsModel
    let need: Need
    let press: (Need, Need.Button) -> Void

    static func primary(_ need: Need) -> (button: Need.Button, label: String)? {
        need.page == nil ? need.acts.first : nil
    }

    var body: some View {
        let primary = Self.primary(need)
        StatusStrip(.needs, title: need.line, line: detail,
                    act: primary.map { primary in .init(primary.label) { press(need, primary.button) } })
        .disabled(needs.working.contains(need.id))
    }

    private var detail: String? {
        let inPlace = !need.acts.contains { $0.button == .do }
        let lines = [need.said(saved: needs.saved.contains(need.id)), inPlace ? needs.refusals[need.id] : nil].compactMap { $0 }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }
}

extension Text {
    func quiet(_ role: Cockpit.Role = .subhead) -> some View {
        cockpit(role).foregroundStyle(Cockpit.Color.textSecondary).fixedSize(horizontal: false, vertical: true)
    }
}

struct VaultAllowSheet: View {
    @ObservedObject var needs: NeedsModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        SheetFrame(Need.allow.line) {
            Text(Need.allow.detail ?? "").quiet(.body)
            if let refusal = needs.refusals[Need.allow.id] { InPlaceLine(refusal) }
        } acts: {
            Button("Not now") { dismiss() }.buttonStyle(.cockpit(.plain)).keyboardShortcut(.cancelAction)
            Button("Allow") { needs.allow() }.buttonStyle(.cockpit(.primary)).keyboardShortcut(.defaultAction)
                .disabled(needs.working.contains(Need.allow.id))
        }
        .onAppear { needs.opened(.allow) }
        .onChange(of: needs.list) { if !needs.list.contains(.allow) { dismiss() } }
    }
}

struct RecoveryKeySheet: View {
    static let lost = "Lost your recovery key?"

    @ObservedObject var needs: NeedsModel
    var lost: () -> Void = {}
    @State private var typed = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        SheetFrame(Need.unlock.line) {
            Text(Need.unlock.detail ?? "").quiet(.body)
            if let opens = KeyName.opensWith(needs.vault) { Text(opens).quiet(.body) }
            SheetPart(nil) {
                SettingRow("Recovery key", separator: false, fieldEnd: true) {
                    Field("Recovery key", text: $typed, secure: true, error: needs.refusals[Need.unlock.id])
                }
            }
        } words: {
            Button(Self.lost) {
                dismiss()
                lost()
            }
            .buttonStyle(.cockpit(.plain))
        } acts: {
            Button("Not now") { dismiss() }.buttonStyle(.cockpit(.plain)).keyboardShortcut(.cancelAction)
            Button("Unlock") { needs.unlock(typed) }.buttonStyle(.cockpit(.primary)).keyboardShortcut(.defaultAction)
                .disabled(typed.isEmpty || needs.working.contains(Need.unlock.id))
        }
        .onAppear { needs.opened(.unlock) }
        .onChange(of: needs.list) { if !needs.list.contains(.unlock) { dismiss() } }
        .onDisappear { typed = "" }
    }
}

struct PasswordSheet: View {
    static let saved = "Saved. Checking…"

    @ObservedObject var needs: NeedsModel
    let need: Need
    let secret: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let draft = Binding(get: { needs.drafts[need.id] ?? "" }, set: { needs.type($0, for: need) })
        SheetFrame(need.line) {
            if let detail = need.detail { Text(detail).quiet(.body) }
            SheetPart(nil) {
                SettingRow("Password", separator: false, fieldEnd: true) {
                    Field("Password", text: draft, secure: true, error: needs.refusals[need.id])
                        .disabled(needs.working.contains(need.id))
                }
            }
        } acts: {
            Button("Not now") { dismiss() }.buttonStyle(.cockpit(.plain)).keyboardShortcut(.cancelAction)
            Button("Save") { needs.save(need, secret: secret) }.buttonStyle(.cockpit(.primary)).keyboardShortcut(.defaultAction)
                .disabled(draft.wrappedValue.isEmpty || needs.working.contains(need.id))
        }
        .onAppear { needs.opened(need) }
        .onChange(of: needs.saved) { if needs.saved.contains(need.id) { dismiss() } }
        .onDisappear { needs.forget() }
    }
}
