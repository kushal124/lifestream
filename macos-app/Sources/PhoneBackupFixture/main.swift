import Foundation
import PhoneBackup

var arguments = Array(CommandLine.arguments.dropFirst())
func fail(_ why: String) -> Never {
    FileHandle.standardError.write(Data("phone-backup-fixture: \(why)\nusage: phone-backup-fixture <folder> [--unencrypted] [--password <password>] [--udid <udid>] [--serial <serial>] [--name <name>] [--apple-id <address>] [--whatsapp <jid>]\n".utf8))
    exit(64)
}
var password: String? = SyntheticBackup.password
var folder: String?
var udid = SyntheticBackup.udid
var serial = SyntheticBackup.serial
var name = SyntheticBackup.deviceName
var appleID = SyntheticBackup.appleID
var ownJID = SyntheticBackup.ownJID
func value(of flag: String) -> String {
    guard !arguments.isEmpty else { fail("\(flag) needs a value") }
    return arguments.removeFirst()
}
while !arguments.isEmpty {
    let argument = arguments.removeFirst()
    switch argument {
    case "--unencrypted": password = nil
    case "--password": password = value(of: argument)
    case "--udid": udid = value(of: argument)
    case "--serial": serial = value(of: argument)
    case "--name": name = value(of: argument)
    case "--apple-id": appleID = value(of: argument)
    case "--whatsapp": ownJID = value(of: argument)
    default:
        guard folder == nil, !argument.hasPrefix("--") else { fail("unknown argument \(argument)") }
        folder = argument
    }
}
guard let folder else { fail("no folder") }
do {
    let root = URL(fileURLWithPath: folder, isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let files = try SyntheticBackup.phone(calls: password != nil, appleID: appleID, ownJID: ownJID)
    let made = try SyntheticBackup.write(in: root, password: password, files: files, udid: udid, serial: serial, deviceName: name)
    print(made.url.path)
} catch {
    fail("\(error)")
}
