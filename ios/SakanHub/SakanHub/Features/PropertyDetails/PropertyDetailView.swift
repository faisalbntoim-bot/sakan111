import SwiftUI

@MainActor
final class PropertyDetailViewModel: ObservableObject {
    @Published var property: Property?
    @Published var summary: String = ""
    @Published var evaluation: AIEvaluation?
    @Published var isSaved: Bool = false
    @Published var rentalMode: Property.Purpose = .rent

    private let repo: PropertyRepository
    private let favs: FavoriteRepository
    private let ai: AIRecommendationService

    init(repo: PropertyRepository,
         favs: FavoriteRepository,
         ai: AIRecommendationService = RepositoryFactory.aiRecommendationService()) {
        self.repo = repo; self.favs = favs; self.ai = ai
    }

    func load(id: Property.ID, userID: User.ID) async {
        property = try? await repo.get(id: id)
        try? await repo.recordView(id: id)
        if let p = property {
            summary = (try? await ai.summarise(property: p)) ?? p.summary
            evaluation = try? await ai.evaluate(property: p)
            rentalMode = p.purpose
        }
        isSaved = await favs.isSaved(propertyID: id, userID: userID)
    }

    func toggleSaved(userID: User.ID) async {
        guard let p = property else { return }
        isSaved = await favs.toggle(propertyID: p.id, userID: userID)
    }
}

struct PropertyDetailView: View {
    let propertyID: Property.ID
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @StateObject private var vm: PropertyDetailViewModel
    @State private var showAR = false
    @State private var showTour = false
    @State private var showBook = false
    @State private var show3D = false
    @State private var shareItem: ShareItem?

    init(propertyID: Property.ID) {
        self.propertyID = propertyID
        _vm = StateObject(wrappedValue: PropertyDetailViewModel(
            repo: RepositoryFactory.propertyRepository(), favs: RepositoryFactory.favoriteRepository()))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                if let p = vm.property { content(p) } else { LoadingView() }
            }
            .background(Theme.bg)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: { Image(systemName: "chevron.left") }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await vm.toggleSaved(userID: MockData.demoUser.id) } } label: {
                        Image(systemName: vm.isSaved ? "heart.fill" : "heart")
                            .foregroundStyle(vm.isSaved ? .pink : Theme.ink)
                    }
                }
            }
            .fullScreenCover(isPresented: $showAR) {
                if let p = vm.property { ARPropertyView(property: p).ignoresSafeArea() }
            }
            .fullScreenCover(isPresented: $showTour) {
                if let p = vm.property { VirtualTourView(property: p) }
            }
            .sheet(isPresented: $showBook) {
                if let p = vm.property { BookingCalendarView(property: p) }
            }
            .sheet(isPresented: $show3D) {
                if let p = vm.property { Property3DView(property: p) }
            }
            .sheet(item: $shareItem) { ShareSheet(text: $0.text) }
            .task { await vm.load(id: propertyID, userID: MockData.demoUser.id) }
        }
    }

    @ViewBuilder private func content(_ p: Property) -> some View {
        VStack(spacing: 12) {
            hero(p)
            header(p)
            specs(p)
            actions(p)
            // "ادخل العقار" — renders as EmptyView when every feature flag is off,
            // so existing property-detail layout is unchanged for standard builds.
            EnterPropertyButton(
                property: p,
                hasGaussianSplat: (p.model3D?.format == .gaussianSplatPly || p.model3D?.format == .gaussianSplatKS),
                hasPanorama:      (p.tour?.rooms.isEmpty == false),
                hasARAnchor:      true
            )
            summarySection
            dealScoreSection
            features(p)
            hostRow(p)
            SectionHeader(title: "الموقع")
            miniMap(p)
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 28)
    }

    private func hero(_ p: Property) -> some View {
        ZStack(alignment: .bottomTrailing) {
            RoundedRectangle(cornerRadius: 20)
                .fill(LinearGradient(colors: [Theme.accent.opacity(0.4), Theme.accentDeep],
                                     startPoint: .topTrailing, endPoint: .bottomLeading))
                .frame(height: 260)
                .overlay(Image(systemName: "photo").font(.system(size: 42)).foregroundStyle(.white.opacity(0.4)))
            HStack(spacing: 8) {
                actionButton(system: "arkit", label: "AR")     { showAR = true }
                actionButton(system: "vr.slash", label: "٣٦٠") { showTour = true }
                actionButton(system: "cube.transparent.fill", label: "٣D") { show3D = true }
            }.padding(12)
        }
    }

    private func actionButton(system: String, label: String, tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            Label(label, systemImage: system)
                .font(.system(size: 12, weight: .heavy))
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(.ultraThinMaterial, in: Capsule())
                .foregroundStyle(.white)
        }.buttonStyle(.plain)
    }

    private func header(_ p: Property) -> some View {
        VStack(alignment: .trailing, spacing: 6) {
            Text(p.title).font(Theme.heading(20, weight: .black)).foregroundStyle(Theme.ink)
            Text("\(p.location.neighborhood) — \(p.location.city)")
                .font(.system(size: 12, weight: .heavy)).foregroundStyle(Theme.textDim)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private func specs(_ p: Property) -> some View {
        HStack(spacing: 8) {
            SpecTile(value: "\(Int(p.areaSquareMeters))", label: "م²")
            if let r = p.rooms { SpecTile(value: "\(r)", label: "غرف") }
            if let b = p.bathrooms { SpecTile(value: "\(b)", label: "حمام") }
            SpecTile(value: "\(Int(p.priceSAR))", label: "ر.س", accent: true)
        }
    }

    private func actions(_ p: Property) -> some View {
        HStack(spacing: 8) {
            PrimaryButton(title: p.purpose == .daily ? "احجز الآن" : "اطلب المعاينة", systemImage: "calendar") {
                showBook = true
            }
            GhostButton(title: "شارك", systemImage: "square.and.arrow.up") {
                shareItem = .init(text: ShareService.shareText(for: p))
            }
        }
    }

    private var summarySection: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "sparkles")
                .foregroundStyle(Theme.accent)
                .padding(6).background(Theme.bg2, in: Circle())
            Text(vm.summary.isEmpty ? "…" : vm.summary)
                .font(Theme.body(13))
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .background(Theme.paper, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
    }

    @ViewBuilder private var dealScoreSection: some View {
        if let e = vm.evaluation {
            VStack(alignment: .trailing, spacing: 10) {
                SectionHeader(title: "مؤشّر الصفقة (AI)")
                HStack(spacing: 16) {
                    RingScore(value: e.dealScore)
                    VStack(alignment: .trailing, spacing: 4) {
                        Text("قوة التفاوض: \(negotiationLabel(e.negotiationPower))")
                            .font(.system(size: 12, weight: .heavy)).foregroundStyle(Theme.textDim)
                        Text("عرضك المقترح: \(Int(e.suggestedOfferSAR)) ر.س")
                            .font(Theme.heading(15, weight: .black)).foregroundStyle(Theme.accentDeep)
                        Text(e.summary).font(Theme.body(11)).foregroundStyle(Theme.textDim)
                    }
                }
            }
            .padding(12)
            .background(Theme.paper, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
        }
    }

    private func features(_ p: Property) -> some View {
        VStack(alignment: .trailing, spacing: 8) {
            SectionHeader(title: "المرافق والمميزات")
            FlowLayout(spacing: 8) {
                ForEach(Array(p.features.chips.enumerated()), id: \.offset) { _, c in
                    if c.on {
                        Chip(text: c.label, systemImage: c.systemImage)
                    }
                }
            }
        }
    }

    private func hostRow(_ p: Property) -> some View {
        HStack(spacing: 10) {
            Circle().fill(Theme.accent).frame(width: 40, height: 40)
                .overlay(Text("م").foregroundStyle(.white).font(.system(size: 15, weight: .black)))
            VStack(alignment: .trailing, spacing: 3) {
                Text(p.purpose == .daily ? "المضيف · فيصل الحربي" : "مكتب الرياض العقاري")
                    .font(Theme.heading(13, weight: .heavy)).foregroundStyle(Theme.ink)
                Text("⭐ 4.8 · يرد خلال ساعة")
                    .font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.textDim)
            }
            Spacer()
            Button { } label: {
                Image(systemName: "message.fill")
                    .font(.system(size: 15, weight: .bold))
                    .frame(width: 38, height: 38)
                    .background(Theme.bg2, in: Circle())
                    .foregroundStyle(Theme.accentDeep)
            }
        }
        .padding(10)
        .background(Theme.paper, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
    }

    private func miniMap(_ p: Property) -> some View {
        MapExploreView(focus: p.location.coordinate, height: 200, interactive: false)
            .frame(height: 200)
            .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    private func negotiationLabel(_ n: AIEvaluation.NegotiationPower) -> String {
        switch n { case .strong: "قوية"; case .medium: "متوسطة"; case .low: "محدودة" }
    }
}

// MARK: - Small helpers

private struct SpecTile: View {
    let value: String
    let label: String
    var accent: Bool = false
    var body: some View {
        VStack(spacing: 2) {
            Text(value).font(Theme.heading(15, weight: .black)).foregroundStyle(accent ? Theme.accentDeep : Theme.ink)
            Text(label).font(.system(size: 10, weight: .heavy)).foregroundStyle(Theme.textDim)
        }
        .frame(maxWidth: .infinity, minHeight: 54)
        .background(Theme.paper, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line, lineWidth: 1))
    }
}

private struct RingScore: View {
    let value: Int   // 0..100
    var body: some View {
        ZStack {
            Circle().stroke(Theme.line, lineWidth: 8)
            Circle().trim(from: 0, to: CGFloat(value) / 100)
                .stroke(LinearGradient(colors: [Theme.accent, Theme.accentDeep],
                                       startPoint: .top, endPoint: .bottom), style: .init(lineWidth: 8, lineCap: .round))
                .rotationEffect(.degrees(-90))
            VStack {
                Text("\(value)").font(Theme.heading(22, weight: .black)).foregroundStyle(Theme.ink)
                Text("/١٠٠").font(.system(size: 10, weight: .heavy)).foregroundStyle(Theme.textDim)
            }
        }
        .frame(width: 80, height: 80)
    }
}

/// Wraps chips onto multiple lines (RTL-friendly).
private struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxW = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, lineH: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x + s.width > maxW { x = 0; y += lineH + spacing; lineH = 0 }
            x += s.width + spacing; lineH = max(lineH, s.height)
        }
        return CGSize(width: maxW, height: y + lineH)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x: CGFloat = bounds.maxX, y = bounds.minY, lineH: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x - s.width < bounds.minX { x = bounds.maxX; y += lineH + spacing; lineH = 0 }
            v.place(at: CGPoint(x: x - s.width, y: y), proposal: .init(s))
            x -= (s.width + spacing); lineH = max(lineH, s.height)
        }
    }
}
