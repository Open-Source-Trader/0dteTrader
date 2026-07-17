import SwiftUI

/// Secure Webull credential entry (PRD FR-2). All three fields are write-only:
/// after saving, the app only ever shows the "Configured" state.
struct WebullCredentialsForm: View {
    @ObservedObject var viewModel: ProfileViewModel

    var body: some View {
        Group {
            SecureField("App Key", text: $viewModel.appKey)
                .textContentType(.password)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

            SecureField("App Secret", text: $viewModel.appSecret)
                .textContentType(.password)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

            SecureField("Account ID", text: $viewModel.accountId)
                .textContentType(.password)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

            Button {
                Task { await viewModel.saveCredentials() }
            } label: {
                HStack {
                    if viewModel.isSavingCredentials {
                        ProgressView()
                    } else {
                        Text("Save Credentials")
                    }
                }
            }
            .disabled(!viewModel.canSaveCredentials || viewModel.isSavingCredentials)
        }
    }
}
