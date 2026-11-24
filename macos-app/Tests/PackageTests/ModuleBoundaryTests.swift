import Foundation
import XCTest

final class ModuleBoundaryTests: XCTestCase {
    private let allowed: [String: Set<String>] = [
        "Evidence": [],
        "Spool": ["Evidence"],
        "BrowserPages": ["Evidence"],
        "Screen": ["Evidence", "BrowserPages"],
        "MachineEvents": ["Evidence"],
        "InputEvents": ["Evidence", "BrowserPages"],
        "Audio": ["Evidence"],
        "Shipping": ["Evidence", "MachineEvents", "InputEvents", "Audio"],
        "Recorder": ["Evidence", "Spool", "Screen", "MachineEvents", "InputEvents", "Audio"],
        "ResourceWatch": ["Evidence"],
        "Passwords": [],
        "PhoneBackup": [],
        "PhoneBackupFixture": ["PhoneBackup"],
        "Lifestream": ["Evidence", "Spool", "BrowserPages", "Screen", "MachineEvents", "InputEvents", "Audio",
                       "Shipping", "Recorder", "ResourceWatch", "Passwords", "PhoneBackup"],
    ]

    private var root: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    func testEveryModuleImportsOnlyWhatItDeclares() throws {
        let modules = Set(allowed.keys)
        XCTAssertEqual(try directories(in: root.appendingPathComponent("Sources")), modules,
                       "A module was added or removed: update this map and Package.swift together")
        for (module, permitted) in allowed {
            for file in try swiftFiles(in: root.appendingPathComponent("Sources").appendingPathComponent(module)) {
                for imported in try imports(in: file).intersection(modules) where imported != module {
                    XCTAssertTrue(permitted.contains(imported),
                                  "\(module) imports \(imported) in \(file.lastPathComponent)")
                }
            }
        }
    }

    func testOnlyTheExecutableImportsSparkleAndCockpit() throws {
        for module in allowed.keys where module != "Lifestream" {
            for file in try swiftFiles(in: root.appendingPathComponent("Sources").appendingPathComponent(module)) {
                let imported = try imports(in: file)
                for outside in ["Sparkle", "Cockpit"] {
                    XCTAssertFalse(imported.contains(outside), "\(module) imports \(outside) in \(file.lastPathComponent)")
                }
            }
        }
    }

    func testEachTestTargetOpensOnlyItsOwnModule() throws {
        let tests = root.appendingPathComponent("Tests")
        for module in allowed.keys {
            let folder = tests.appendingPathComponent(module + "Tests")
            guard FileManager.default.fileExists(atPath: folder.path) else { continue }
            for file in try swiftFiles(in: folder) {
                let opened = try testableImports(in: file)
                XCTAssertTrue(opened.subtracting([module]).isEmpty,
                              "\(file.lastPathComponent) opens \(opened.sorted()) with @testable")
            }
        }
    }

    private func directories(in url: URL) throws -> Set<String> {
        Set(try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: [.isDirectoryKey])
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            .map(\.lastPathComponent))
    }

    private func swiftFiles(in url: URL) throws -> [URL] {
        let files = FileManager.default.enumerator(at: url, includingPropertiesForKeys: nil)?.allObjects as? [URL] ?? []
        return files.filter { $0.pathExtension == "swift" }
    }

    private func imports(in file: URL) throws -> Set<String> {
        try lines(in: file).compactMap { line in
            let words = line.split(separator: " ")
            guard let index = words.firstIndex(of: "import"), index + 1 < words.count else { return nil }
            guard words[..<index].allSatisfy({ $0.hasPrefix("@") }) else { return nil }
            return String(words[index + 1])
        }.reduce(into: Set<String>()) { $0.insert($1) }
    }

    private func testableImports(in file: URL) throws -> Set<String> {
        Set(try lines(in: file).filter { $0.hasPrefix("@testable import ") }
            .map { String($0.dropFirst("@testable import ".count)) })
    }

    private func lines(in file: URL) throws -> [String] {
        try String(contentsOf: file, encoding: .utf8).split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }

}
