# Store Review Notes

The app is an open-source brokerage client. It does not custody assets or provide investment advice. Reviewers can use practice mode with test credentials supplied through the review channel.

Required disclosures are available from Profile without starting a trade. Terms and risk acceptance are versioned server-side. The human-readable Privacy Policy is publicly reachable at `/v1/legal/privacy-policy` on the deployed API origin. Account deletion is available in Profile and removes the user row plus all user-owned data through database cascade constraints.

Suggested age rating: 18+ because the app provides access to financial trading and real-money brokerage accounts. The app contains no gambling mechanics, social wagering, or simulated casino content.

Export compliance: the app uses standard operating-system and HTTPS encryption for authentication, credential protection, and transport. Release owners must answer App Store encryption questions for the exact binary and distribution jurisdiction; this repository does not contain a proprietary cryptographic algorithm or export-controlled encryption product.
