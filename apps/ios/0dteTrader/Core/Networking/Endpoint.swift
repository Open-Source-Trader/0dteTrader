import Foundation

/// A REST endpoint description. Paths are relative to `AppConfig.apiBaseURL`
/// and carry no leading slash (e.g. "v1/market/quote").
struct Endpoint: Sendable {
    enum Method: String, Sendable {
        case get = "GET"
        case post = "POST"
        case put = "PUT"
        case patch = "PATCH"
        case delete = "DELETE"
    }

    var method: Method
    var path: String
    var query: [URLQueryItem]
    var requiresAuth: Bool
    var headers: [String: String]

    init(
        method: Method,
        path: String,
        query: [URLQueryItem] = [],
        requiresAuth: Bool = true,
        headers: [String: String] = [:]
    ) {
        self.method = method
        self.path = path
        self.query = query
        self.requiresAuth = requiresAuth
        self.headers = headers
    }
}
