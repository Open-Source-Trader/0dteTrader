import SwiftUI

struct WebullCredentialsForm: View {
    @ObservedObject var viewModel: ProfileViewModel

    private enum Field: Hashable {
        case appKey, appSecret
    }

    @FocusState private var focused: Field?

    var body: some View {
        VStack(spacing: AppSpacing.md) {
            SecureField("App Key", text: $viewModel.appKey)
                .textContentType(.none)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focused, equals: .appKey)
                .submitLabel(.next)
                .onSubmit { focused = .appSecret }
                .authField(isFocused: focused == .appKey)

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
                .authField(isFocused: focused == .appSecret)

            Text("Your account is detected automatically after you approve the connection in the Webull app.")
                .font(.chipLabel)
                .foregroundStyle(.secondary)

            Button {
                Task { await viewModel.saveCredentials() }
            } label: {
                HStack(spacing: AppSpacing.sm) {
                    if viewModel.isSavingCredentials {
                        ProgressView().controlSize(.small).tint(Color.appAccent)
                    }
                    Text("Save Credentials")
                        .font(.hudButton)
                        .kerning(0.5)
                }
                .foregroundStyle(Color.appAccent.opacity(
                    viewModel.canSaveCredentials && !viewModel.isSavingCredentials ? 1 : AppOpacity.disabled
                ))
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(HudActionButtonStyle(
                accent: Color.appAccent.opacity(
                    viewModel.canSaveCredentials && !viewModel.isSavingCredentials ? 1 : AppOpacity.disabled
                ),
                chamfer: 6
            ))
            .disabled(!viewModel.canSaveCredentials || viewModel.isSavingCredentials)
        }
    }
}
