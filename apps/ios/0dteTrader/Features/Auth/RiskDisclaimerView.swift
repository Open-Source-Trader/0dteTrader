import SwiftUI

/// First-launch risk disclosure (SECURITY.md §6). The user must accept before
/// any other screen is reachable; acceptance is persisted in SettingsStore.
struct RiskDisclaimerView: View {
    @ObservedObject var viewModel: AuthViewModel

    var body: some View {
        VStack(spacing: 20) {
            Text("Risk Disclosure")
                .font(.title.bold())
                .padding(.top, 32)

            ScrollView {
                Text(disclaimerText)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
            }

            Button {
                Haptics.impact(.medium)
                viewModel.acceptDisclaimer()
            } label: {
                Text("I Understand and Accept")
                    .font(.headline)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background(Color.appAccent)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .padding(.bottom, 8)
        }
        .padding(24)
    }

    private var disclaimerText: String {
        """
        Trading securities, options, and futures involves substantial risk of loss and is not suitable for every investor. You may lose all of your invested capital.

        Options on their expiration date ("0DTE") are especially volatile: prices can move violently in minutes, liquidity can disappear, and positions can expire worthless the same day. Futures trading involves leverage and can result in losses exceeding your initial investment.

        0dteTrader is an order-entry tool only. It does not provide investment advice, recommendations, or analysis, and nothing in the app should be interpreted as such. Order routing, contract selection, and pricing are validated by the backend, but market conditions, connectivity, or broker outages may prevent or delay execution.

        By tapping "I Understand and Accept" you acknowledge these risks and agree that you are solely responsible for every order submitted through this app.
        """
    }
}
