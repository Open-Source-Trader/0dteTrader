import SwiftUI

struct LoginView: View {
    @ObservedObject var viewModel: AuthViewModel

    @State private var email = ""
    @State private var password = ""
    @State private var showRegister = false

    private var isFormValid: Bool {
        email.contains("@") && !password.isEmpty
    }

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            VStack(spacing: 6) {
                Text("0dteTrader")
                    .font(.largeTitle.bold())
                Text("Rapid options & futures trading")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            VStack(spacing: 14) {
                TextField("Email", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(12)
                    .background(Color.appSurface)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .padding(12)
                    .background(Color.appSurface)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            }

            if let errorMessage = viewModel.errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(Color.pnlNegative)
                    .multilineTextAlignment(.center)
            }

            Button {
                Task {
                    await viewModel.login(email: email.trimmingCharacters(in: .whitespaces), password: password)
                }
            } label: {
                Group {
                    if viewModel.isLoading {
                        ProgressView()
                            .tint(.white)
                    } else {
                        Text("Log In")
                            .font(.headline)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 50)
                .background(isFormValid ? Color.appAccent : Color.appAccent.opacity(0.35))
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!isFormValid || viewModel.isLoading)

            Button("Create an account") {
                showRegister = true
            }
            .font(.subheadline)
            .foregroundStyle(Color.appAccent)

            Spacer()
        }
        .padding(24)
        .scrollDismissesKeyboard(.interactively)
        .sheet(isPresented: $showRegister) {
            RegisterView(viewModel: viewModel)
        }
    }
}
