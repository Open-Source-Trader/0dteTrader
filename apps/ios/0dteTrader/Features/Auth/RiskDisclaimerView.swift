import SwiftUI

/// First-launch risk disclosure (SECURITY.md §6). The user must accept before
/// any other screen is reachable; acceptance is persisted in SettingsStore.
struct RiskDisclaimerView: View {
    @ObservedObject var viewModel: AuthViewModel

    var body: some View {
        VStack(spacing: 0) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 40))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(Color.appWarning)
                .padding(.top, AppSpacing.xxxl)
                .accessibilityHidden(true)

            Text("Risk Disclosure")
                .font(.custom("Orbitron-Bold", size: 22, relativeTo: .title))
                .foregroundStyle(Color.hudAmber)
                .shadow(color: Color.hudAmber.opacity(0.4), radius: 8)
                .accessibilityAddTraits(.isHeader)
                .padding(.top, AppSpacing.lg)

            ScrollView {
                Text(disclaimerText)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineSpacing(AppSpacing.xs)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.top, AppSpacing.xxl)
            // Bottom fade signals that the copy continues when truncated.
            .overlay(alignment: .bottom) {
                LinearGradient(colors: [Color.appBackground.opacity(0), Color.appBackground],
                               startPoint: .top, endPoint: .bottom)
                    .frame(height: AppSpacing.xxxl)
                    .allowsHitTesting(false)
            }

            Button {
                Haptics.success()
                viewModel.acceptDisclaimer()
            } label: {
                Text("I Understand and Accept")
                    .font(.hudButton)
                    .kerning(1)
                    .foregroundStyle(Color.appAccent)
                    .shadow(color: .hudGlow, radius: 6)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .contentShape(Rectangle())
            }
            .buttonStyle(HudActionButtonStyle(accent: .appAccent))
            .accessibilityHint("Accepts the risk disclosure and continues to sign in")
            .padding(.top, AppSpacing.lg)
            .padding(.bottom, AppSpacing.sm)
        }
        .padding(AppSpacing.xxl)
    }

    // swiftlint:disable line_length
    private var disclaimerText: String {
        """
        Trading securities, options, and futures involves substantial risk of loss and is not suitable for every investor. You may lose all of your invested capital.

        Options on their expiration date ("0DTE") are especially volatile: prices can move violently in minutes, liquidity can disappear, and positions can expire worthless the same day. Futures trading involves leverage and can result in losses exceeding your initial investment.

        0dteTrader is an order-entry tool only. It does not provide investment advice, recommendations, or analysis, and nothing in the app should be interpreted as such. Order routing, contract selection, and pricing are validated by the backend, but market conditions, connectivity, or broker outages may prevent or delay execution.

        By tapping "I Understand and Accept" you acknowledge these risks and agree that you are solely responsible for every order submitted through this app.
        """
    }
    // swiftlint:enable line_length
}
