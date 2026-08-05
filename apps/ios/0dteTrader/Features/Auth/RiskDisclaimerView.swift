import SwiftUI

/// Preliminary first-launch warning (SECURITY.md §6). Versioned legal
/// acceptance happens against the server after authentication.
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
                Text("Acknowledge and Continue")
                    .font(.hudButton)
                    .kerning(1)
                    .foregroundStyle(Color.appAccent)
                    .shadow(color: .hudGlow, radius: 6)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .contentShape(Rectangle())
            }
            .buttonStyle(HudActionButtonStyle(accent: .appAccent))
            .accessibilityHint("Acknowledges this warning and continues to sign in")
            .padding(.top, AppSpacing.lg)
            .padding(.bottom, AppSpacing.sm)
        }
        .padding(AppSpacing.xxl)
    }

    // swiftlint:disable line_length
    private var disclaimerText: String {
        """
        Trading securities and options involves substantial risk of loss and is not suitable for every investor. You may lose all of your invested capital.

        Options on their expiration date ("0DTE") are especially volatile: prices can move violently in minutes, liquidity can disappear, and positions can expire worthless the same day.

        0dteTrader provides order-entry and optional informational analysis tools. AI-generated and market analysis can be wrong, incomplete, or outdated and is not personalized investment advice or an order instruction. Market conditions, connectivity, or broker outages may prevent or delay execution.

        Continuing acknowledges this first-launch warning. After signing in, you must review and accept the current server-hosted Terms and Options Risk Disclosure before arming or placing trades. You remain responsible for every order submitted through your account.
        """
    }
    // swiftlint:enable line_length
}
