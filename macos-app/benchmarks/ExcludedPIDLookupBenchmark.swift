import AppKit
import Darwin

func cpuSeconds() -> Double {
    var usage = rusage()
    getrusage(RUSAGE_SELF, &usage)
    return Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec)
        + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1_000_000
}
func scan(_ identifiers: Set<String>) -> Set<pid_t> {
    Set(NSWorkspace.shared.runningApplications.filter {
        $0.bundleIdentifier.map(identifiers.contains) == true
    }.map(\.processIdentifier))
}
func query(_ identifiers: Set<String>, checkExactIdentifier: Bool) -> Set<pid_t> {
    guard !identifiers.isEmpty else { return [] }
    var pids = Set<pid_t>()
    for identifier in identifiers {
        for application in NSRunningApplication.runningApplications(withBundleIdentifier: identifier) {
            if !checkExactIdentifier || application.bundleIdentifier.map(identifiers.contains) == true {
                pids.insert(application.processIdentifier)
            }
        }
    }
    return pids
}
struct Timing: Codable {
    let method: String
    let iterations: Int
    let wallSeconds: Double
    let cpuSeconds: Double
    let resultCountSum: Int
}
struct Scenario: Codable {
    let label: String
    let identifierCount: Int
    let expectedPIDCount: Int
    let multipleInstancesPresent: Bool
    let stableBracket: Bool
    let rawQueryMatches: Bool
    let exactQueryMatches: Bool
    let timings: [Timing]
}
func measure(_ name: String, iterations: Int, operation: () -> Set<pid_t>) -> Timing {
    let wall = ProcessInfo.processInfo.systemUptime, cpu = cpuSeconds()
    var count = 0
    for _ in 0..<iterations { autoreleasepool { count += operation().count } }
    return Timing(method: name, iterations: iterations,
        wallSeconds: ProcessInfo.processInfo.systemUptime-wall, cpuSeconds: cpuSeconds()-cpu, resultCountSum: count)
}
var arguments = Array(CommandLine.arguments.dropFirst())
var iterations = 200
if arguments.first == "--iterations", arguments.count >= 2 {
    iterations = min(10_000, max(1, Int(arguments[1]) ?? 200)); arguments.removeFirst(2)
}
let liveIdentifiers = Set(NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier))
let configured = arguments.isEmpty ? Set(liveIdentifiers.sorted().prefix(5)) : Set(arguments)
let cases: [(String, Set<String>)] = [
    ("configured", configured), ("empty", []),
    ("case-variants", Set(configured.map { $0.uppercased() })),
    ("all-running-identifiers", liveIdentifiers)
]
var reports: [Scenario] = []
for (label, identifiers) in cases {
    let before = scan(identifiers)
    let raw = query(identifiers, checkExactIdentifier: false)
    let checked = query(identifiers, checkExactIdentifier: true)
    let after = scan(identifiers)
    let multiple = identifiers.contains { scan([$0]).count > 1 }
    let timings = [
        measure("scan", iterations: iterations) { scan(identifiers) },
        measure("query", iterations: iterations) { query(identifiers, checkExactIdentifier: false) },
        measure("query-exact", iterations: iterations) { query(identifiers, checkExactIdentifier: true) }
    ]
    reports.append(Scenario(label: label, identifierCount: identifiers.count, expectedPIDCount: before.count,
        multipleInstancesPresent: multiple, stableBracket: before == after,
        rawQueryMatches: raw == before && raw == after, exactQueryMatches: checked == before && checked == after,
        timings: timings))
}
let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
FileHandle.standardOutput.write(try encoder.encode(reports))
FileHandle.standardOutput.write(Data([10]))
