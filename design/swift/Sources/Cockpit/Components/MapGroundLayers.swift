#if canImport(UIKit)
import MapKit
import UIKit

open class GroundMapView: MKMapView {
    open class var veiled: Bool { false }
    private lazy var ground = MapGroundLayers(veiled: type(of: self).veiled)

    public override init(frame: CGRect) {
        super.init(frame: frame)
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self]) { (map: GroundMapView, _) in
            map.ground.paint(for: map.traitCollection)
        }
    }

    @available(*, unavailable)
    public required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    open override func layoutSubviews() {
        super.layoutSubviews()
        ground.lay(in: self)
    }

    public func reveal() { ground.reveal() }
}

@MainActor final class MapGroundLayers {
    private let veiled: Bool
    private weak var base: UIView?
    private let tint = MapGroundLayers.layer("colorBlendMode")
    private let veil = MapGroundLayers.layer(nil)
    private let dim = MapGroundLayers.layer("multiplyBlendMode")
    private let cover = MapGroundLayers.layer(nil)
    private var revealed = false
    private var waiting = false
    static let patience: Duration = .seconds(3)

    init(veiled: Bool) {
        self.veiled = veiled
    }

    func lay(in map: MKMapView) {
        if base?.superview == nil || base?.superview !== tint.superview || base?.isDescendant(of: map) != true {
            for layer in [tint, veil, dim, cover] { layer.removeFromSuperview() }
            base = Self.baseMap(in: map)
            guard let base, let holder = base.superview else { return }
            holder.insertSubview(tint, aboveSubview: base)
            holder.insertSubview(veil, aboveSubview: tint)
            holder.insertSubview(dim, aboveSubview: veil)
            if !revealed { holder.insertSubview(cover, aboveSubview: dim) }
            paint(for: map.traitCollection)
            if !waiting, !revealed {
                waiting = true
                Task { @MainActor [weak self] in
                    try? await Task.sleep(for: Self.patience)
                    self?.reveal()
                }
            }
        }
        guard let frame = base?.frame else { return }
        for layer in [tint, veil, dim, cover] where layer.frame != frame { layer.frame = frame }
    }

    func paint(for traits: UITraitCollection) {
        let land = UIColor(MapGround.land).resolvedColor(with: traits)
        tint.backgroundColor = land
        let veiling = traits.userInterfaceStyle == .light ? MapGround.veil.light : MapGround.veil.dark
        veil.backgroundColor = veiled ? land.withAlphaComponent(veiling) : .clear
        dim.backgroundColor = UIColor(MapGround.dim).resolvedColor(with: traits)
        cover.backgroundColor = land
    }

    func reveal() {
        guard !revealed else { return }
        revealed = true
        let fade = UIView.areAnimationsEnabled && !UIAccessibility.isReduceMotionEnabled
        UIView.animate(withDuration: fade ? Cockpit.Duration.base : 0, animations: { self.cover.alpha = 0 },
                       completion: { _ in self.cover.removeFromSuperview() })
    }

    private static func layer(_ blend: String?) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        if let blend { view.layer.compositingFilter = blend }
        return view
    }

    private static func baseMap(in view: UIView) -> UIView? {
        for subview in view.subviews {
            if String(describing: type(of: subview)).hasSuffix("BasicMapView") { return subview }
            if let found = baseMap(in: subview) { return found }
        }
        return nil
    }
}
#endif
