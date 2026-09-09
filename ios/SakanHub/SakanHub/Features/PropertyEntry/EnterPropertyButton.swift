import SwiftUI

/// "ادخل العقار" (Enter Property) call-to-action button + presentation
/// routing. Place it in a property-detail sheet; it will render as
/// `EmptyView` when every relevant feature flag is off, so existing UI
/// looks unchanged for users who don't have the feature enabled.
///
/// This view NEVER pushes/replaces the existing property flow — it
/// presents its destination as a modal sheet.
struct EnterPropertyButton: View {
    let property: Property
    /// Signals whether the property carries any 3D/panorama/AR content.
    /// Callers pass concrete detection results; kept as flags so the
    /// router has no direct data-model coupling.
    let hasGaussianSplat: Bool
    let hasPanorama:      Bool
    let hasARAnchor:      Bool

    @State private var destination: EnterPropertyDestination?

    var body: some View {
        // If the whole subsystem is off, render nothing — the property
        // detail view keeps its existing layout untouched.
        if FeatureFlags.enterPropertyAnyEnabled {
            Button(action: openDestination) {
                Label("ادخل العقار", systemImage: "cube.transparent.fill")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .padding(.horizontal)
            .sheet(item: sheetBinding()) { dest in
                destinationView(dest)
            }
        }
    }

    private func openDestination() {
        destination = EnterPropertyRouter.route(
            hasGaussianSplat: hasGaussianSplat,
            hasPanorama:      hasPanorama,
            hasARAnchor:      hasARAnchor
        )
    }

    private func sheetBinding() -> Binding<EnterPropertyDestination?> {
        Binding(
            get: { destination },
            set: { destination = $0 }
        )
    }

    @ViewBuilder
    private func destinationView(_ dest: EnterPropertyDestination) -> some View {
        switch dest {
        case .gaussianSplat3D:
            Property3DView(property: property)
        case .panorama360:
            // Delegate to the existing SceneKit-based viewer. The tour URL
            // comes from the caller's Property model / VirtualTour asset.
            VirtualTourView(property: property)
        case .arView:
            ARPropertyView(property: property)
        case .aiTour(let reason):
            UnavailableTourSheet(title: "الجولة الذكية غير متاحة", message: reason)
        case .unavailable(let reason):
            UnavailableTourSheet(title: "لا توجد جولة", message: reason)
        }
    }
}

// MARK: - Sheet identifier conformance

extension EnterPropertyDestination: Identifiable {
    var id: String {
        switch self {
        case .gaussianSplat3D:                    return "gs"
        case .panorama360:                        return "pano"
        case .aiTour:                             return "ai"
        case .arView:                             return "ar"
        case .unavailable:                        return "none"
        }
    }
}

// MARK: - Honest "not available" sheet

/// Shown when a tour type is not backed by real infrastructure. We do
/// NOT fake a working viewer — we tell the user honestly.
struct UnavailableTourSheet: View {
    let title: String
    let message: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "info.circle").font(.system(size: 44))
            Text(title).font(.title3.bold())
            Text(message).multilineTextAlignment(.center).foregroundStyle(.secondary)
                .padding(.horizontal, 24)
            Button("موافق") { dismiss() }.padding(.top, 8)
        }
        .padding(.vertical, 40)
    }
}
