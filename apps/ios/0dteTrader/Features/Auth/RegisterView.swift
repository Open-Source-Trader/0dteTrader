import SwiftUI

struct RegisterView: View {
    @ObservedObject var viewModel: AuthViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""

    private var validationMessage: String? {
        if !email.contains("@") { return "Enter a valid email address." }
        if password.count < 8 { return "Password must be at least 8 characters." }
        if password != confirmPassword { return "Passwords do not match." }
        return nil
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                VStack(spacing: 14) {
                    TextField("Email", text: $email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(12)
                        .background(Color.appSurface)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                    SecureField("Password (8+ characters)", text: $password)
                        .textContentType(.newPassword)
                        .padding(12)
                        .background(Color.appSurface)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                    SecureField("Confirm password", text: $confirmPassword)
                        .textContentType(.newPassword)
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
                        await viewModel.register(
                            email: email.trimmingCharacters(in: .whitespaces),
                            password: password
                        )
                    }
                } label: {
                    Group {
                        if viewModel.isLoading {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Text("Create Account")
                                .font(.headline)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background(validationMessage == nil ? Color.appAccent : Color.appAccent.opacity(0.35))
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(validationMessage != nil || viewModel.isLoading)

                Spacer()
            }
            .padding(24)
            .navigationTitle("Create Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}
