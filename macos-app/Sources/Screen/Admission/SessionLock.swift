import CoreGraphics
import CoreFoundation
import Foundation

enum SessionLock {
    static let observedLockKey = "CGSSessionScreenIsLocked"

    static func permitsCapture(_ dictionary: [String: Any]?) -> Bool {
        guard let dictionary,
              strictBoolean(dictionary[kCGSessionOnConsoleKey as String]) == true else { return false }
        guard let lock = dictionary[observedLockKey] else { return true }
        return strictBoolean(lock) == false
    }

    private static func strictBoolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }
}
