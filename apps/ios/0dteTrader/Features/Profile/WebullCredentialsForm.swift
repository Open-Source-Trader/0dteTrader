import SwiftUI

/// Secure Webull credential entry (PRD FR-2). All three fields are write-only:
/// after saving, the app only ever shows the "Configured" state.
struct WebullCredentialsForm: View {
    @ObservedObject var viewModel: ProfileViewModel

    private enum Field: Hashable {
        case appKey, appSecret, accountId
    }

    @FocusState private var focused: Field?

    var body: some View {
        Group {
            SecureField("App Key", text: $viewModel.appKey)
                // Not a login password — suppress Keychain autofill prompts.
                .textContentType(.none)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focused, equals: .appKey)
                .submitLabel(.next)
                .onSubmit { focused = .appSecret }

            SecureField("App Secret", text: $viewModel.appSecret)
                .textContentType(.password)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focused, equals: .appSecret)
                .submitLabel(.next)
                .onSubmit { focused = .accountId }

            // An identifier, not a secret — keep it visible so pasted values
            // can be verified before saving.
            TextField("Account ID", text: $viewModel.accountId)
                .textContentType(.none)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.system(.body, design: .monospaced))
                .focused($focused, equals: .accountId)
                .submitLabel(.go)
                .onSubmit {
                    guard viewModel.canSaveCredentials else { return }
                    Task { await viewModel.saveCredentials() }
                }

            Button {
                Task { await viewModel.saveCredentials() }
            } label: {
                // Constant label keeps the row from jumping when the spinner
                // appears next to it.
                HStack(spacing: AppSpacing.sm) {
                    if viewModel.isSavingCredentials {
                        ProgressView().controlSize(.small)
                    }
                    Text("Save Credentials")
                }
                .frame(maxWidth: .infinity)
            }
            .disabled(!viewModel.canSaveCredentials || viewModel.isSavingCredentials)
        }
    }
}
