import SwiftUI

/// Authenticated, versioned Terms and risk acceptance. Acceptance is written
/// to the backend and the gate returns whenever either document version moves.
struct LegalGateView: View {
    @ObservedObject var viewModel: AuthViewModel
    @State private var accepted: Set<LegalDocumentSlug> = []

    private var allAccepted: Bool {
        viewModel.legalDocuments.allSatisfy { accepted.contains($0.slug) }
    }

    var body: some View {
        VStack(spacing: AppSpacing.lg) {
            Text("Required Disclosures")
                .font(.custom("Orbitron-Bold", size: 22, relativeTo: .title))
                .foregroundStyle(Color.hudAmber)
                .accessibilityAddTraits(.isHeader)

            Text("Review and accept the current versions before placing orders.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: AppSpacing.xxl) {
                    ForEach(viewModel.legalDocuments, id: \.slug) { document in
                        VStack(alignment: .leading, spacing: AppSpacing.md) {
                            Text(document.title)
                                .font(.headline)
                            Text(document.markdown)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                            Toggle(isOn: binding(for: document.slug)) {
                                Text("I reviewed and accept version \(document.version).")
                                    .font(.subheadline)
                            }
                            .tint(.appAccent)
                        }
                    }
                }
            }

            if let errorMessage = viewModel.errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(Color.sellRed)
            }

            Button("Accept and Continue") {
                Task { await viewModel.acceptRequiredLegal() }
            }
            .buttonStyle(HudActionButtonStyle(accent: .appAccent))
            .disabled(!allAccepted || viewModel.isLoading)
        }
        .padding(AppSpacing.xxl)
    }

    private func binding(for slug: LegalDocumentSlug) -> Binding<Bool> {
        Binding(
            get: { accepted.contains(slug) },
            set: { checked in
                if checked { accepted.insert(slug) }
                else { accepted.remove(slug) }
            }
        )
    }
}
