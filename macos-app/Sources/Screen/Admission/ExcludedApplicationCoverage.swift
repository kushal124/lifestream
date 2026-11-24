import Foundation

enum ExcludedApplicationCoverage {
    static func permits(running: Set<Int32>, filtered: Set<Int32>, visible: @autoclosure () -> Set<Int32>?) -> Bool {
        if running.isSubset(of: filtered) { return true }
        guard let visible = visible() else { return false }
        return running.intersection(visible).isSubset(of: filtered)
    }
}
