import SwiftUI

/// Write-only Webull credential entry for one environment (live / practice).
/// Fields are local `@State` (write-only: never re-displayed after saving — FR-4).
struct WebullCredentialsForm: View {
    @ObservedObject var viewModel: ProfileViewModel
    let environment: TradingMode

    @State private var appKey = ""
    @State private var appSecret = ""

    private enum Field: Hashable { case appKey, appSecret }
    @FocusState private var focused: Field?

    private var canSave: Bool {
        !appKey.trimmingCharacters(in: .whitespaces).isEmpty && !appSecret.isEmpty
    }
    private var isSaving: Bool {
        viewModel.savingWebull.contains(environment)
    }

    var body: some View {
        VStack(spacing: AppSpacing.md) {
            TextField("App Key", text: $appKey)
                .textContentType(.none)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .focused($focused, equals: .appKey)
                .submitLabel(.next)
                .onSubmit { focused = .appSecret }
                .authField(isFocused: focused == .appKey)

            TextField("App Secret", text: $appSecret)
                .textContentType(.none)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .focused($focused, equals: .appSecret)
                .submitLabel(.go)
                .onSubmit {
                    guard canSave else { return }
                    Task { await viewModel.saveWebull(environment: environment, appKey: appKey, appSecret: appSecret) }
                }
                .authField(isFocused: focused == .appSecret)

            Text("Your account is detected automatically after you approve the connection in the Webull app.")
                .font(.chipLabel)
                .foregroundStyle(.secondary)

            Button {
                Task { await viewModel.saveWebull(environment: environment, appKey: appKey, appSecret: appSecret) }
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
