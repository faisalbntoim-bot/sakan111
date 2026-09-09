import Foundation

/// Feature flags for the "ادخل العقار" (Enter Property) subsystem.
///
/// All flags DEFAULT to OFF. Reading from Info.plist means a build
/// (via `Sakan.xcconfig`) enables them; there is no runtime UI to
/// toggle them, and no server round-trip that could turn them on
/// unexpectedly.
///
/// Info.plist keys (String, "YES" / "NO"):
///   - PROPERTY_CAMERA_TEST_ENABLED
///   - PROPERTY_3D_CAPTURE_ENABLED
///   - PROPERTY_3D_VIEWER_ENABLED
///   - PROPERTY_AR_ENABLED
///
/// ⚠️  Enabling PROPERTY_3D_CAPTURE_ENABLED simply exposes the capture
///     UI. There is NO real 3D Gaussian Splatting pipeline; the backend
///     will respond with `processingStatus = failed` + "not configured"
///     until a real GPU service is wired in. The UI must surface that
///     message honestly and NOT show a "your 3D tour is ready" state.
enum FeatureFlags {

    private static func read(_ key: String) -> Bool {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String else {
            return false
        }
        return (raw as NSString).boolValue
    }

    static var propertyCameraTestEnabled: Bool { read("PROPERTY_CAMERA_TEST_ENABLED") }
    static var property3DCaptureEnabled:  Bool { read("PROPERTY_3D_CAPTURE_ENABLED")  }
    static var property3DViewerEnabled:   Bool { read("PROPERTY_3D_VIEWER_ENABLED")   }
    static var propertyAREnabled:         Bool { read("PROPERTY_AR_ENABLED")          }

    /// Any capture / viewer / AR entry point.
    static var enterPropertyAnyEnabled: Bool {
        propertyCameraTestEnabled
            || property3DCaptureEnabled
            || property3DViewerEnabled
            || propertyAREnabled
    }
}
