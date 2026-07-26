import SwiftUI

// Saving a new server URL rebuilds the app container, which re-identities the
// whole view tree (ZeroDTETraderApp keys RootView on the container) and wipes
// this screen's @State — including any presented sheet. This file-scope flag
// carries the "continue to Register after picking a server" intent across that
// remount; the remounted LoginView consumes it in onAppear. Mirrors the
// module-level flag in `apps/desktop/src/features/auth/LoginView.tsx`.
@MainActor private var resumeRegisterAfterRebuild = false

struct LoginView: View {
    @ObservedObject var viewModel: AuthViewModel
    @EnvironmentObject private var serverConfig: ServerConfigStore

    @State private var email = ""
    @State private var password = ""
    @State private var activeSheet: AuthSheet?
    @FocusState private var focusedField: LoginField?

    private enum LoginField: Hashable {
        case email, password
    }

    /// Why the server picker is open: creating an account, or the footer link.
    private enum ServerSelectIntent {
        case register, change
    }

    /// One `sheet(item:)` for both steps so "server chosen → register" swaps
    /// the sheet's content in place instead of racing a dismiss + present.
    private enum AuthSheet: Identifiable {
        case serverSelect(ServerSelectIntent)
        case register

        var id: String {
            switch self {
            case .serverSelect: return "serverSelect"
            case .register: return "register"
            }
        }
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
                    Text("Open Source Trader")
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
                    viewModel.errorMessage = nil
                    activeSheet = .serverSelect(.register)
                }
                .font(.subheadline)
                .foregroundStyle(Color.appAccent)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())

                Spacer()

                // Quiet footer link for self-hosters: opens the same server
                // picker without entering the create-account flow.
                Button {
                    activeSheet = .serverSelect(.change)
                } label: {
                    // One concatenated Text so a long host wraps as a single
                    // line of prose instead of splitting around "Change".
                    (Text("Server: \(ServerSelect.hostLabel(serverConfig.baseURL)) · ")
                        .foregroundStyle(.secondary)
                        + Text("Change").foregroundStyle(Color.appAccent))
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                        .frame(minHeight: 32)
                        .padding(.horizontal, AppSpacing.md)
                        .contentShape(Rectangle())
                }
                .buttonStyle(AppPressStyle())
                .accessibilityLabel("Server: \(ServerSelect.hostLabel(serverConfig.baseURL))")
                .accessibilityHint("Opens the server picker")
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
        .onAppear {
            // Consume the resume flag left by finishServerSelect before the
            // container rebuild remounted this screen.
            if resumeRegisterAfterRebuild {
                resumeRegisterAfterRebuild = false
                activeSheet = .register
            }
        }
        .sheet(item: $activeSheet) { sheet in
            Group {
                switch sheet {
                case .serverSelect(let intent):
                    ServerSelectView { serverChanged in
                        finishServerSelect(intent: intent, serverChanged: serverChanged)
                    }
                case .register:
                    RegisterView(viewModel: viewModel)
                }
            }
            // Sheets sit outside the root window's tree, so `RootView`'s
            // tap/swipe keyboard dismissal does not reach them — each
            // sheet with a field carries its own.
            .dismissKeyboardOnInteraction()
        }
    }

    private func finishServerSelect(intent: ServerSelectIntent, serverChanged: Bool) {
        guard intent == .register else {
            activeSheet = nil
            return
        }
        if serverChanged {
            // The container rebuild is about to remount this screen (tearing
            // down the sheet with it); resume the register flow there.
            resumeRegisterAfterRebuild = true
        } else {
            // Same server: swap the sheet's content to RegisterView in place.
            activeSheet = .register
        }
    }

    private func submit() {
        guard isFormValid, !viewModel.isLoading else { return }
        Task {
            await viewModel.login(email: email.trimmingCharacters(in: .whitespaces), password: password)
        }
    }
}
