import SwiftUI

/// Secure Webull credential entry (PRD FR-2). Both fields are write-only:
/// after saving, the app only ever shows the "Configured" state. The account
/// id is not entered — the server discovers it via Webull's account/list
/// after the connection is approved (official flow).
struct WebullCredentialsForm: View {
    @ObservedObject var viewModel: ProfileViewModel

    private enum Field: Hashable {
        case appKey, appSecret
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
                .submitLabel(.go)
                .onSubmit {
                    guard viewModel.canSaveCredentials else { return }
                    Task { await viewModel.saveCredentials() }
                }

            Text("Your account is detected automatically after you approve the connection in the Webull app.")
                .font(.footnote)
                .foregroundStyle(.secondary)

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
