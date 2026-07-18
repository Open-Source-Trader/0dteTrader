import SwiftUI
import UIKit

/// Shared styling for auth form fields: surface fill plus a visible border
/// (WCAG 1.4.11 non-text contrast) and an accent focus ring while focused.
struct AuthFieldStyle: ViewModifier {
    var isFocused = false

    func body(content: Content) -> some View {
        content
            .padding(AppSpacing.md)
            .background(Color.appSurface, in: RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous)
                    .strokeBorder(
                        isFocused ? Color.appAccent : Color.appBorder,
                        lineWidth: isFocused ? 1.5 : 1
                    )
            )
    }
}

extension View {
    func authField(isFocused: Bool = false) -> some View {
        modifier(AuthFieldStyle(isFocused: isFocused))
    }
}

/// Password field with a visibility (eye) toggle, styled like the other auth
/// fields. Used by LoginView and RegisterView so the styling never drifts.
struct AuthPasswordField<Field: Hashable>: View {
    let placeholder: String
    @Binding var text: String
    var contentType: UITextContentType = .password
    var focused: FocusState<Field?>.Binding
    var field: Field
    var submitLabel: SubmitLabel = .go
    var onSubmit: () -> Void = {}

    @State private var isVisible = false

    var body: some View {
        HStack(spacing: 0) {
            Group {
                if isVisible {
                    TextField(placeholder, text: $text)
                } else {
                    SecureField(placeholder, text: $text)
                }
            }
            .textContentType(contentType)
            .focused(focused, equals: field)
            .submitLabel(submitLabel)
            .onSubmit(onSubmit)
            .accessibilityLabel(placeholder)

            Button {
                isVisible.toggle()
            } label: {
                Image(systemName: isVisible ? "eye.slash.fill" : "eye.fill")
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(AppPressStyle())
            .accessibilityLabel(isVisible ? "Hide password" : "Show password")
        }
        .padding(.leading, AppSpacing.md)
        .background(Color.appSurface, in: RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous)
                .strokeBorder(
                    focused.wrappedValue == field ? Color.appAccent : Color.appBorder,
                    lineWidth: focused.wrappedValue == field ? 1.5 : 1
                )
        )
    }
}

/// Full-width primary CTA for the auth flow: loading spinner + label,
/// AA-passing accent fill, press feedback and a 52pt hit target.
struct AuthPrimaryButton: View {
    let title: String
    var loadingTitle: String? = nil
    var isLoading = false
    var isEnabled = true
    var accessibilityID = "auth.submit"
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: AppSpacing.sm) {
                if isLoading {
                    ProgressView()
                        .tint(.white)
                    if let loadingTitle {
                        Text(loadingTitle)
                    }
                } else {
                    Text(title)
                }
            }
            .font(.headline)
            .foregroundStyle(isEnabled ? Color.white : Color.white.opacity(0.5))
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(Color.appAccentFill.opacity(isEnabled ? 1 : AppOpacity.disabled))
            .clipShape(RoundedRectangle(cornerRadius: AppRadius.lg, style: .continuous))
            .contentShape(Rectangle())
            .animation(AppMotion.quick, value: isEnabled)
        }
        .buttonStyle(AppPressStyle())
        .disabled(!isEnabled || isLoading)
        .accessibilityIdentifier(accessibilityID)
    }
}
