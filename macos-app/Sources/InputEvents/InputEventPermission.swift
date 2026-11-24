import CoreGraphics

public enum InputEventPermission {
    public static var granted: Bool { CGPreflightListenEventAccess() }
}
