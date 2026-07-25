import SwiftUI

/// Write-only SnapTrade Personal client ID / consumer key entry for one
/// environment (live / practice). Fields are local `@State` (write-only:
/// never re-displayed after saving — FR-4). This is the user's own SnapTrade
/// identity (docs.snaptrade.com/docs/personal-vs-commercial) — 0dteTrader
/// never mints or holds a SnapTrade identity on their behalf.
struct SnapTradeCredentialsForm: View {
    @ObservedObject var viewModel: ProfileViewModel
    let environment: TradingMode

    @State private var clientId = ""
    @State private var consumerKey = ""

    private enum Field: Hashable { case clientId, consumerKey }
    @FocusState private var focused: Field?

    private var canSave: Bool {
        !clientId.trimmingCharacters(in: .whitespaces).isEmpty && !consumerKey.isEmpty
    }
    private var isSaving: Bool {
        viewModel.savingSnapTradeKey.contains(environment)
    }

    var body: some View {
        VStack(spacing: AppSpacing.md) {
            TextField("Client ID", text: $clientId)
                .textContentType(.none)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .focused($focused, equals: .clientId)
                .submitLabel(.next)
                .onSubmit { focused = .consumerKey }
                .authField(isFocused: focused == .clientId)

            SecureField("Consumer Key", text: $consumerKey)
                .textContentType(.none)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .focused($focused, equals: .consumerKey)
                .submitLabel(.go)
                .onSubmit {
                    guard canSave else { return }
                    Task {
                        await viewModel.saveSnapTradeKey(
                            environment: environment,
                            clientId: clientId,
                            consumerKey: consumerKey
                        )
                    }
                }
                .authField(isFocused: focused == .consumerKey)

            Text("Create a free Personal client ID and consumer key in your own SnapTrade Dashboard — 0dteTrader never sees or stores your brokerage login.")
                .font(.chipLabel)
                .foregroundStyle(.secondary)

            Button {
                Task {
                    await viewModel.saveSnapTradeKey(
                        environment: environment,
                        clientId: clientId,
                        consumerKey: consumerKey
                    )
                }
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
