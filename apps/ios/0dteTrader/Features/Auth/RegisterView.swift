import SwiftUI
import UIKit

struct RegisterView: View {
    @ObservedObject var viewModel: AuthViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""
    @FocusState private var focusedField: Field?

    private enum Field: Hashable {
        case email, password, confirm
    }

    private var isEmailValid: Bool {
        email.range(of: #"^[^@\s]+@[^@\s]+\.[^@\s]+$"#, options: .regularExpression) != nil
    }

    /// Strict gate for enabling the CTA.
    private var isFormValid: Bool {
        isEmailValid && password.count >= 8 && password == confirmPassword
    }

    /// Shown above the CTA; each rule only appears once its field has input,
    /// so the screen doesn't scold the user before they've typed anything.
    private var validationMessage: String? {
        if !email.isEmpty && !isEmailValid { return "Enter a valid email address." }
        if !password.isEmpty && password.count < 8 { return "Password must be at least 8 characters." }
        if !confirmPassword.isEmpty && password != confirmPassword { return "Passwords do not match." }
        return nil
    }

    private var displayMessage: String? {
        viewModel.errorMessage ?? validationMessage
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: AppSpacing.xl) {
                    Spacer()

                    VStack(spacing: AppSpacing.md) {
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
                            contentType: .newPassword,
                            focused: $focusedField,
                            field: .password,
                            submitLabel: .next
                        ) {
                            focusedField = .confirm
                        }

                        Text("Minimum 8 characters")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)

                        AuthPasswordField(
                            placeholder: "Confirm password",
                            text: $confirmPassword,
                            contentType: .newPassword,
                            focused: $focusedField,
                            field: .confirm,
                            submitLabel: .go
                        ) {
                            submit()
                        }
                    }

                    if let message = displayMessage {
                        Label(message, systemImage: "exclamationmark.circle.fill")
                            .font(.footnote)
                            .foregroundStyle(Color.sellRed)
                            .multilineTextAlignment(.center)
                            .accessibilityElement(children: .combine)
                            .accessibilityAddTraits(.isStaticText)
                            .transition(.opacity.combined(with: .move(edge: .top)))
                    }

                    AuthPrimaryButton(
                        title: "Create Account",
                        loadingTitle: "Creating account…",
                        isLoading: viewModel.isLoading,
                        isEnabled: isFormValid,
                        accessibilityID: "register.submit"
                    ) {
                        submit()
                    }

                    Spacer()
                }
                .padding(AppSpacing.xxl)
                .frame(maxWidth: .infinity)
                .containerRelativeFrame(.vertical)
                .animation(AppMotion.standard, value: displayMessage)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: viewModel.errorMessage) { _, message in
                if let message {
                    Haptics.error()
                    UIAccessibility.post(notification: .announcement, argument: message)
                }
            }
            .navigationTitle("Sign Up")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .disabled(viewModel.isLoading)
                }
            }
            .interactiveDismissDisabled(viewModel.isLoading)
        }
    }

    private func submit() {
        guard isFormValid, !viewModel.isLoading else { return }
        Task {
            await viewModel.register(
                email: email.trimmingCharacters(in: .whitespaces),
                password: password
            )
        }
    }
}
