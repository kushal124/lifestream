import Cockpit
import Foundation
import HomeLink
import LifestreamCaptureCore
import SwiftUI

@MainActor
final class InspectorReads: ObservableObject {
    private let life: LifeReader
    private var records: [HomeLink.DayFile.RecordRef: Task<HomeLink.Record, Error>] = [:]
    private var extracts: [String: Task<[HomeLink.Extract], Error>] = [:]
    private var kinds: Task<[HomeLink.PrivacyState.Kind], Error>?

    init(life: LifeReader = AppRuntime.shared.life) {
        self.life = life
    }

    func record(_ ref: HomeLink.DayFile.RecordRef) async throws -> HomeLink.Record {
        try await once(\.records, ref) { [life] in try await life.record(source: ref.source, kind: ref.kind, key: ref.key) }
    }

    struct Went: Sendable, Identifiable {
        let row: HomeLink.Outbound
        let kinds: [HomeLink.PrivacyState.Kind]
        var id: Int { row.seq }
    }

    func went(_ item: HomeLink.Made.Ask) async throws -> Went? {
        guard let row = try await life.outbound(of: item).first else { return nil }
        return Went(row: row, kinds: try await detailKinds())
    }

    func sent(seq: Int) async throws -> Went {
        let row = try await life.outbound(seq: seq)
        return Went(row: row, kinds: try await detailKinds())
    }

    func original(_ hash: String) async throws -> Data {
        try await life.blob(hash)
    }

    func extracts(family: String, unit: String) async throws -> [HomeLink.Extract] {
        try await once(\.extracts, family + "/" + unit) { [life] in
            do {
                return try await life.extracts(family: family, unit: unit)
            } catch LifeReader.Failure.missing {
                return []
            }
        }
    }

    private func detailKinds() async throws -> [HomeLink.PrivacyState.Kind] {
        let task = kinds ?? Task { [life] in try await life.privacy().types }
        kinds = task
        do {
            return try await task.value
        } catch {
            if kinds == task { kinds = nil }
            throw error
        }
    }

    private func once<Key: Hashable, Value: Sendable>(_ held: ReferenceWritableKeyPath<InspectorReads, [Key: Task<Value, Error>]>,
                                                      _ key: Key,
                                                      _ read: @escaping @MainActor @Sendable () async throws -> Value) async throws -> Value {
        let task = self[keyPath: held][key] ?? Task { try await read() }
        self[keyPath: held][key] = task
        do {
            return try await task.value
        } catch {
            if self[keyPath: held][key] == task { self[keyPath: held][key] = nil }
            throw error
        }
    }
}

enum Inspector {}

extension Inspector {
    struct Reading<Value, Skeleton: View, Content: View>: View {
        let missing: String
        let inset: CGFloat
        let read: () async throws -> Value
        let skeleton: Skeleton
        private var framed = false
        let content: (Value) -> Content
        @State private var phase: Phase = .reading
        @State private var attempt = 0

        private enum Phase {
            case reading
            case read(Value)
            case failed(LifeReader.Failure)

            var reading: Bool {
                if case .reading = self { return true }
                return false
            }
        }

        init(missing: String, inset: CGFloat = 0, _ read: @escaping () async throws -> Value,
             @ViewBuilder skeleton: () -> Skeleton, @ViewBuilder content: @escaping (Value) -> Content) {
            self.missing = missing
            self.inset = inset
            self.read = read
            self.skeleton = skeleton()
            self.content = content
        }

        var body: some View {
            Group {
                switch phase {
                case .reading:
                    skeleton
                        .reading(!framed)
                        .transition(.identity)
                case .read(let value):
                    content(value)
                case .failed(let failure):
                    ReadLack(failure, lacks: "This isn't on this iPhone yet.", words: sentence(failure),
                                retry: retries(failure) ? { attempt += 1 } : nil)
                        .padding(inset)
                }
            }
            .animation(.easeOut(duration: Cockpit.Duration.fast), value: phase.reading)
            .readsAgain(failed: { if case .failed(let failure) = phase { failure } else { nil } }) { attempt += 1 }
            .task(id: attempt) {
                phase = .reading
                do {
                    phase = .read(try await read())
                } catch is CancellationError {
                } catch let failure as LifeReader.Failure {
                    phase = .failed(failure)
                } catch {
                    phase = .failed(.refused(String(describing: error)))
                }
            }
        }

        private func sentence(_ failure: LifeReader.Failure) -> String? {
            switch failure {
            case .unpaired: "Pair with Lifestream to see this."
            case .reach: nil
            case .busy(let words, _, _, _): words
            case .missing: missing
            case .refused(let words), .failed(let words), .unknown(let words): Inspector.Family.sentence(words)
            }
        }

        private func retries(_ failure: LifeReader.Failure) -> Bool {
            failure != .unpaired && failure != .missing
        }
    }

    struct Lines: View {
        var body: some View {
            VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                ForEach(["The words of this moment, as its source keeps them, read", "from Lifestream and drawn here at once when they",
                         "arrive in this place"], id: \.self) { line in
                    Text(line).cockpit(.body).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

extension Inspector.Reading where Skeleton == Inspector.Lines {
    init(missing: String, inset: CGFloat = 0, _ read: @escaping () async throws -> Value,
         @ViewBuilder content: @escaping (Value) -> Content) {
        self.init(missing: missing, inset: inset, read, skeleton: { Inspector.Lines() }, content: content)
    }
}

extension Inspector.Reading where Skeleton == Inspector.ReadingFrame<Inspector.Lines> {
    init(missing: String, inset: CGFloat = 0, head: Inspector.Head?, _ read: @escaping () async throws -> Value,
         @ViewBuilder content: @escaping (Value) -> Content) {
        self.init(missing: missing, inset: inset, read, skeleton: { Inspector.ReadingFrame(head: head) { Inspector.Lines() } },
                  content: content)
        framed = true
    }
}

extension Inspector {
    struct Gone: View {
        var body: some View {
            HStack(spacing: Cockpit.Space.s2) {
                Icon(.hidden, size: .sm)
                Text("This record was deleted at its source.")
                    .cockpit(.footnote)
            }
            .foregroundStyle(Cockpit.Color.textSecondary)
            .accessibilityElement(children: .combine)
        }
    }
}

extension Inspector {
    enum Source {
        @MainActor static func line(source: String?, family: String, unit: String?) -> String? {
            line(source: source, family: family, unit: unit, names: ProductsBook.shared.names)
        }

        static func line(source: String?, family: String, unit: String?, names: ProductNames) -> String? {
            let id = source ?? unit?.split(separator: "/").map(String.init).first { $0.split(separator: ":").count >= 3 }
            guard let id else { return families[family] }
            return names.name(of: id)
        }

        private static let families = [
            "physical": "Location", "screen": "Screen Time", "web": "Browsing", "phone": "Screen Time", "photos": "Photos",
            "health": "Health", "listening": "Listening", "money": "Money",
        ]
    }
}
