import XCTest
@testable import ResourceWatch

final class AppProcessTests: XCTestCase {
    private var root: URL!
    private var bundle: URL { root.appendingPathComponent("Fake.app") }
    private var running: [Process] = []

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("app-process-\(UUID().uuidString)")
        let macOS = bundle.appendingPathComponent("Contents/MacOS")
        try FileManager.default.createDirectory(at: macOS, withIntermediateDirectories: true)
        let source = root.appendingPathComponent("wait.c")
        try Data("#include <unistd.h>\nint main(void) { for (;;) pause(); }\n".utf8).write(to: source)
        let compiler = Process()
        compiler.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        compiler.arguments = ["clang", source.path, "-o", macOS.appendingPathComponent("Lifestream").path]
        try compiler.run()
        compiler.waitUntilExit()
        XCTAssertEqual(compiler.terminationStatus, 0)
        let info = try PropertyListSerialization.data(fromPropertyList: [AppProcessFinder.buildKey: "0abc123"],
                                                      format: .xml, options: 0)
        try info.write(to: bundle.appendingPathComponent("Contents/Info.plist"))
    }

    override func tearDownWithError() throws {
        for process in running where process.isRunning {
            process.terminate()
            process.waitUntilExit()
        }
        try? FileManager.default.removeItem(at: root)
    }

    private func launch(_ arguments: [String]) throws -> Process {
        let process = Process()
        process.executableURL = bundle.appendingPathComponent("Contents/MacOS/Lifestream")
        process.arguments = arguments
        try process.run()
        running.append(process)
        return process
    }

    func testTheAppIsTheProcessRunningTheAppCommandAndARestartIsANewProcess() throws {
        _ = try launch(["live-status"])
        let finder = AppProcessFinder(bundle: bundle)
        XCTAssertNil(finder.read(), "a CLI command run from the bundle is not the app")

        let first = try launch(["--ocr", "exact"])
        let reading = try XCTUnwrap(finder.read())
        XCTAssertEqual(reading.pid, first.processIdentifier)
        XCTAssertEqual(reading.build, "0abc123")
        XCTAssertEqual(reading.usage.threads, 1)
        XCTAssertEqual(try XCTUnwrap(finder.read()).started, reading.started, "the same process while its pid lives")

        first.terminate()
        first.waitUntilExit()
        XCTAssertNil(finder.read())
        let second = try launch(["--"])
        let restarted = try XCTUnwrap(finder.read())
        XCTAssertEqual(restarted.pid, second.processIdentifier)
        XCTAssertGreaterThanOrEqual(restarted.started, reading.started)
    }

    func testABundleWithoutTheBuildKeyStatesUnknown() throws {
        try Data("<plist version=\"1.0\"><dict/></plist>".utf8).write(to: bundle.appendingPathComponent("Contents/Info.plist"))
        _ = try launch(["--"])
        XCTAssertEqual(AppProcessFinder(bundle: bundle).read()?.build, "unknown")
    }
}
