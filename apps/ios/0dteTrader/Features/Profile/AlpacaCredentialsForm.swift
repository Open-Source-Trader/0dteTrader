import SwiftUI

/// Write-only Alpaca credential entry (API key + secret). Alpaca v2 is
/// key-scoped, so there is no account id to discover.
struct AlpacaCredentialsForm: View {
    @ObservedObject var viewModel: ProfileViewModel

    private enum Field: Hashable {
        case apiKey, apiSecret
    }

    @FocusState private var focused: Field?

    var body: some View {
        VStack(spacing: AppSpacing.md) {
            TextField("API Key", text: $viewModel.alpacaApiKey)
                .textContentType(.none)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .focused($focused, equals: .apiKey)
                .submitLabel(.next)
                .onSubmit { focused = .apiSecret }
                .authField(isFocused: focused == .apiKey)

            SecureField("API Secret", text: $viewModel.alpacaApiSecret)
                .textContentType(.none)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .focused($focused, equals: .apiSecret)
                .submitLabel(.go)
                .onSubmit {
                    guard viewModel.canSaveAlpacaCredentials else { return }
                    Task { await viewModel.saveAlpacaCredentials() }
                }
                .authField(isFocused: focused == .apiSecret)

            Text("Your API key and secret identify your Alpaca account — no separate account id is needed.")
                .font(.chipLabel)
                .foregroundStyle(.secondary)

            Button {
                Task { await viewModel.saveAlpacaCredentials() }
            } label: {
                HStack(spacing: AppSpacing.sm) {
                    if viewModel.isSavingAlpacaCredentials {
                        ProgressView().controlSize(.small).tint(Color.appAccent)
                    }
                    Text("Save Credentials")
                        .font(.hudButton)
                        .kerning(0.5)
                }
                .foregroundStyle(Color.appAccent.opacity(
                    viewModel.canSaveAlpacaCredentials && !viewModel.isSavingAlpacaCredentials ? 1 : AppOpacity.disabled
                ))
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(HudActionButtonStyle(
                accent: Color.appAccent.opacity(
                    viewModel.canSaveAlpacaCredentials && !viewModel.isSavingAlpacaCredentials ? 1 : AppOpacity.disabled
                ),
                chamfer: 6
            ))
            .disabled(!viewModel.canSaveAlpacaCredentials || viewModel.isSavingAlpacaCredentials)
        }
    }
}
