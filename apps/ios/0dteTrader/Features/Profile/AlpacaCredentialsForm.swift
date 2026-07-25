import SwiftUI

/// Write-only Alpaca credential entry for one environment (live / practice).
/// Fields are local `@State` (write-only: never re-displayed after saving — FR-4).
struct AlpacaCredentialsForm: View {
    @ObservedObject var viewModel: ProfileViewModel
    let environment: TradingMode

    @State private var apiKey = ""
    @State private var apiSecret = ""

    private enum Field: Hashable { case apiKey, apiSecret }
    @FocusState private var focused: Field?

    private var canSave: Bool {
        !apiKey.trimmingCharacters(in: .whitespaces).isEmpty && !apiSecret.isEmpty
    }
    private var isSaving: Bool {
        viewModel.savingAlpaca.contains(environment)
    }

    var body: some View {
        VStack(spacing: AppSpacing.md) {
            TextField("API Key", text: $apiKey)
                .textContentType(.none)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .focused($focused, equals: .apiKey)
                .submitLabel(.next)
                .onSubmit { focused = .apiSecret }
                .authField(isFocused: focused == .apiKey)

            SecureField("API Secret", text: $apiSecret)
                .textContentType(.none)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .focused($focused, equals: .apiSecret)
                .submitLabel(.go)
                .onSubmit {
                    guard canSave else { return }
                    Task { await viewModel.saveAlpaca(environment: environment, apiKey: apiKey, apiSecret: apiSecret) }
                }
                .authField(isFocused: focused == .apiSecret)

            Text("Use the key/secret for the matching environment. The server connects to Alpaca's live or paper API accordingly.")
                .font(.chipLabel)
                .foregroundStyle(.secondary)

            Button {
                Task { await viewModel.saveAlpaca(environment: environment, apiKey: apiKey, apiSecret: apiSecret) }
            } label: {
                HStack(spacing: AppSpacing.sm) {
                    if isSaving { ProgressView().controlSize(.small).tint(Color.appAccent) }
                    Text("Save Credentials")
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
