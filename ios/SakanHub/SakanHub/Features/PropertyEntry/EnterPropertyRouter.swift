import Foundation

/// The "ادخل العقار" (Enter Property) router — decides which viewer to
/// present for a given property based on what content is available and
/// which feature flags are on.
///
/// Priority (highest first):
///   1. gaussian_splat tour → Property3DView (needs PROPERTY_3D_VIEWER_ENABLED)
///   2. panorama_360 tour   → VirtualTourView (always available if viewer flag on)
///   3. ai_tour             → not available yet — surface honest message
///   4. AR view             → ARPropertyView (needs PROPERTY_AR_ENABLED)
///
/// If nothing matches, callers show a "no tour available" empty state
/// instead of opening a broken screen.
enum EnterPropertyDestination: Equatable {
    case gaussianSplat3D
    case panorama360
    case aiTour(unavailableReason: String)
    case arView
    case unavailable(reason: String)
}

enum EnterPropertyRouter {

    /// Given a property's optional 3D model + optional virtual-tour URL,
    /// pick a destination honouring feature flags.
    static func route(hasGaussianSplat: Bool,
                      hasPanorama: Bool,
                      hasARAnchor: Bool) -> EnterPropertyDestination {

        if hasGaussianSplat && FeatureFlags.property3DViewerEnabled {
            return .gaussianSplat3D
        }
        if hasPanorama && FeatureFlags.property3DViewerEnabled {
            return .panorama360
        }
        if hasARAnchor && FeatureFlags.propertyAREnabled {
            return .arView
        }
        if !FeatureFlags.enterPropertyAnyEnabled {
            return .unavailable(reason: "خاصية «ادخل العقار» غير مفعّلة في هذا الإصدار.")
        }
        return .unavailable(reason: "لا توجد جولة متاحة لهذا العقار بعد.")
    }
}
