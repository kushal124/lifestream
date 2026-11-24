import Foundation

enum EngineError: Error, CustomStringConvertible {
    case request(String)
    case failed(String)

    var description: String {
        switch self {
        case .request(let message): "unreadable request: \(message)"
        case .failed(let message): message
        }
    }
}

func log(_ message: String) {
    FileHandle.standardError.write(Data("face-engine: \(message)\n".utf8))
}
