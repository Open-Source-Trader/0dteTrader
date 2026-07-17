import CryptoKit
import Foundation

/// URLSession delegate implementing SPKI (public key) SHA-256 pinning per docs/SECURITY.md §5.
///
/// Pinning is configuration-gated: when `AppConfig.pinnedPublicKeyHashes` is empty
/// (local development over http://localhost), all challenges get default handling.
/// Populate the hashes of the backend's SPKI when deploying behind TLS.
final class CertificatePinningDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
    private let pinnedHashes: Set<String>

    init(pinnedHashes: [String]) {
        self.pinnedHashes = Set(pinnedHashes)
    }

    private var isEnabled: Bool {
        !pinnedHashes.isEmpty
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard isEnabled,
              challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let serverTrust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        // Require the standard TLS chain validation to pass first.
        var evaluationError: CFError?
        guard SecTrustEvaluateWithError(serverTrust, &evaluationError) else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        if let chain = SecTrustCopyCertificateChain(serverTrust) as? [SecCertificate] {
            for certificate in chain {
                guard let publicKey = SecCertificateCopyKey(certificate),
                      let spkiData = SecKeyCopyExternalRepresentation(publicKey, nil) as Data?
                else {
                    continue
                }
                let digest = SHA256.hash(data: spkiData)
                if pinnedHashes.contains(Data(digest).base64EncodedString()) {
                    completionHandler(.useCredential, URLCredential(trust: serverTrust))
                    return
                }
            }
        }
        completionHandler(.cancelAuthenticationChallenge, nil)
    }
}
