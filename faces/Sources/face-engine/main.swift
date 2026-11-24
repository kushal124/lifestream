import Foundation


let usage = "usage: face-engine scan|group|draw|read|make|picture|self-check <request.json> <result.json>"
let arguments = CommandLine.arguments
guard arguments.count == 4 else {
    log(usage)
    exit(2)
}
let (command, requestPath, resultPath) = (arguments[1], arguments[2], arguments[3])

func read<T: Decodable>(_ type: T.Type) throws -> T {
    guard let data = FileManager.default.contents(atPath: requestPath) else {
        throw EngineError.request("cannot read \(requestPath)")
    }
    do {
        return try JSONDecoder().decode(type, from: data)
    } catch {
        throw EngineError.request("\(requestPath): \(error)")
    }
}

func write<T: Encodable>(_ result: T) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    do {
        try (encoder.encode(result) + Data("\n".utf8)).write(to: URL(fileURLWithPath: resultPath), options: .atomic)
    } catch {
        throw EngineError.failed("cannot write \(resultPath): \(error.localizedDescription)")
    }
}

do {
    switch command {
    case "scan": try write(Scan.run(read(Scan.Request.self)))
    case "group": try write(Group.run(read(Group.Request.self)))
    case "draw": try write(Draw.run(read(Draw.Request.self)))
    case "read": try write(Read.run(read(Read.Request.self)))
    case "make": try write(Make.run(read(Make.Request.self)))
    case "picture": try write(Upright.run(read(Upright.Request.self)))
    case "self-check": try write(SelfCheck.run(read(SelfCheck.Request.self)))
    default:
        log(usage)
        exit(2)
    }
} catch let error as EngineError {
    log(error.description)
    if case .request = error { exit(2) }
    exit(1)
} catch {
    log("\(error)")
    exit(1)
}
