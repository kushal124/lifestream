#if canImport(UIKit)
import MapKit
import SwiftUI

public struct StillMap: UIViewRepresentable {
    let rect: MKMapRect

    public init(rect: MKMapRect) {
        self.rect = rect
    }

    public static func rect(around centre: CLLocationCoordinate2D, metres: CLLocationDistance, size: CGSize) -> MKMapRect {
        let across = metres * MKMapPointsPerMeterAtLatitude(centre.latitude)
        let wide = Double(max(size.width, 1)), tall = Double(max(size.height, 1))
        let scale = min(wide, tall) / across
        let at = MKMapPoint(centre)
        return MKMapRect(x: at.x - wide / 2 / scale, y: at.y - tall / 2 / scale, width: wide / scale, height: tall / scale)
    }

    public func makeUIView(context: Context) -> StillMapView {
        let map = StillMapView()
        let configuration = MKStandardMapConfiguration(elevationStyle: .flat, emphasisStyle: .muted)
        configuration.pointOfInterestFilter = .excludingAll
        configuration.showsTraffic = false
        map.preferredConfiguration = configuration
        map.isScrollEnabled = false
        map.isZoomEnabled = false
        map.isRotateEnabled = false
        map.isPitchEnabled = false
        map.showsUserLocation = false
        map.insetsLayoutMarginsFromSafeArea = false
        map.layoutMargins = .zero
        map.isAccessibilityElement = false
        map.delegate = context.coordinator
        return map
    }

    public func updateUIView(_ map: StillMapView, context: Context) {
        map.overrideUserInterfaceStyle = context.environment.colorScheme == .dark ? .dark : .light
        map.stand(on: rect)
    }

    public func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor public final class Coordinator: NSObject, MKMapViewDelegate {
        public func mapViewDidFinishRenderingMap(_ mapView: MKMapView, fullyRendered: Bool) {
            (mapView as? GroundMapView)?.reveal()
        }
    }
}

public final class StillMapView: GroundMapView {
    private var rect: MKMapRect?
    private var stood: (MKMapRect, CGSize)?

    func stand(on rect: MKMapRect) {
        self.rect = rect
        setNeedsLayout()
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        guard let rect, bounds.width > 0, bounds.height > 0 else { return }
        if let stood, MKMapRectEqualToRect(stood.0, rect), stood.1 == bounds.size { return }
        stood = (rect, bounds.size)
        setVisibleMapRect(rect, animated: false)
    }
}
#endif
