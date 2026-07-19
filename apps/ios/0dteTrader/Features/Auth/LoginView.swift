import SwiftUI

struct LoginView: View {
    @ObservedObject var viewModel: AuthViewModel

    @State private var email = ""
    @State private var password = ""
    @State private var showRegister = false
    @FocusState private var focusedField: LoginField?

    private enum LoginField: Hashable {
        case email, password
    }

    private var isFormValid: Bool {
        email.contains("@") && !password.isEmpty
    }

    var body: some View {
        ScrollView {
            VStack(spacing: AppSpacing.xxl) {
                Spacer()

                VStack(spacing: AppSpacing.sm) {
                    Text("0dteTrader")
                        .font(.custom("Orbitron-Bold", size: 30, relativeTo: .largeTitle))
                        .foregroundStyle(Color.appAccent)
                        .shadow(color: .hudGlow, radius: 10)
                    Text("Rapid options trading")
                        .font(.panelLabel)
                        .foregroundStyle(.secondary)
                }

                VStack(spacing: AppSpacing.lg) {
                    TextField("Email", text: $email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focusedField, equals: .email)
                        .submitLabel(.next)
                        .onSubmit { focusedField = .password }
                        .accessibilityLabel("Email address")
                        .authField(isFocused: focusedField == .email)

                    AuthPasswordField(
                        placeholder: "Password",
                        text: $password,
                        contentType: .password,
                        focused: $focusedField,
                        field: .password,
                        submitLabel: .go
                    ) {
                        submit()
                    }
                }

                if let errorMessage = viewModel.errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(Color.sellRed)
                        .multilineTextAlignment(.center)
                        .accessibilityAddTraits(.isStaticText)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }

                AuthPrimaryButton(
                    title: "Log In",
                    isLoading: viewModel.isLoading,
                    isEnabled: isFormValid,
                    accessibilityID: "login.submit"
                ) {
                    submit()
                }

                Button("Create an account") {
                    showRegister = true
                }
                .font(.subheadline)
                .foregroundStyle(Color.appAccent)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())

                Spacer()
            }
            .padding(AppSpacing.xxl)
            .frame(maxWidth: .infinity)
            .containerRelativeFrame(.vertical)
            .animation(AppMotion.standard, value: viewModel.errorMessage)
        }
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: viewModel.errorMessage) { _, message in
            if message != nil {
                Haptics.error()
            }
        }
        .sheet(isPresented: $showRegister) {
            RegisterView(viewModel: viewModel)
        }
    }

    private func submit() {
        guard isFormValid, !viewModel.isLoading else { return }
        Task {
            await viewModel.login(email: email.trimmingCharacters(in: .whitespaces), password: password)
        }
    }
}
