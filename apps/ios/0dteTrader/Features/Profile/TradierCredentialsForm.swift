import SwiftUI

/// Write-only Tradier API key entry for one environment (live / practice).
/// Tradier auth is a single bearer token — one field. The stored key is
/// never re-displayed after saving (FR-4).
struct TradierCredentialsForm: View {
    @ObservedObject var viewModel: ProfileViewModel
    let environment: TradingMode

    @State private var apiKey = ""
    @FocusState private var focused: Bool

    private var canSave: Bool {
        !apiKey.trimmingCharacters(in: .whitespaces).isEmpty
    }
    private var isSaving: Bool {
        viewModel.savingTradier.contains(environment)
    }

    var body: some View {
        VStack(spacing: AppSpacing.md) {
            SecureField("API Key", text: $apiKey)
                .textContentType(.none)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .focused($focused)
                .submitLabel(.go)
                .onSubmit {
                    guard canSave else { return }
                    Task { await viewModel.saveTradier(environment: environment, apiKey: apiKey) }
                }
                .authField(isFocused: focused)

            Text("Your access token comes from the Tradier dashboard (use the sandbox token for practice).")
                .font(.chipLabel)
                .foregroundStyle(.secondary)

            Button {
                Task { await viewModel.saveTradier(environment: environment, apiKey: apiKey) }
            } label: {
                HStack(spacing: AppSpacing.sm) {
                    if isSaving { ProgressView().controlSize(.small).tint(Color.appAccent) }
                    Text("Save API Key")
                        .font(.hudButton)
                        .kerning(0.5)
                }
                .foregroundStyle(Color.appAccent.opacity(canSave && !isSaving ? 1 : AppOpacity.disabled))
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(HudActionButtonStyle(
                accent: Color.appAccent.opacity(canSave && !isSaving ? 1 : AppOpacity.disabled),
                chamfer: 6
            ))
            .disabled(!canSave || isSaving)
        }
    }
}
