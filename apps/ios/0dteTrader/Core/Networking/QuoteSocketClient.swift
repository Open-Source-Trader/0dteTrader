import Foundation

enum SocketConnectionState: Equatable {
    case disconnected
    case connecting
    case connected
}

/// WebSocket client for `GET /v1/stream?token=<accessToken>`.
///
/// - subscribe/unsubscribe messages per the API contract;
/// - publishes quotes per symbol, order updates and server errors for SwiftUI consumers;
/// - automatically reconnects with exponential backoff + jitter, re-authenticating
///   (fresh access token) on every reconnect attempt and re-subscribing after reconnect.
@MainActor
final class QuoteSocketClient: ObservableObject {
    @Published private(set) var connectionState: SocketConnectionState = .disconnected
    @Published private(set) var quotes: [String: Quote] = [:]
    @Published private(set) var lastQuote: Quote?
    @Published private(set) var lastOrderUpdate: OrderResult?
    @Published private(set) var lastErrorMessage: String?

    private let streamURL: URL
    private let tokenProvider: () async throws -> String
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private let urlSession: URLSession

    private var webSocketTask: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var subscribedSymbols: Set<String> = []
    private var shouldBeConnected = false
    private var reconnectAttempt = 0

    init(streamURL: URL, urlSession: URLSession = .shared, tokenProvider: @escaping () async throws -> String) {
        self.streamURL = streamURL
        self.urlSession = urlSession
        self.tokenProvider = tokenProvider
    }

    // MARK: - Lifecycle

    func connect() {
        shouldBeConnected = true
        reconnectAttempt = 0
        reconnectTask?.cancel()
        reconnectTask = nil
        openConnection()
    }

    func disconnect() {
        shouldBeConnected = false
        reconnectTask?.cancel()
        reconnectTask = nil
        teardownConnection()
        connectionState = .disconnected
    }

    /// Called on app foreground: re-establish the stream if it dropped while suspended.
    func reconnectIfNeeded() {
        guard shouldBeConnected, connectionState == .disconnected, reconnectTask == nil else { return }
        reconnectAttempt = 0
        openConnection()
    }

    /// Force a fresh connection, re-subscribing the current symbols. Called after
    /// the trading provider changes so live quotes immediately use the new provider
    /// (the dispatcher resolves the provider per call, but an already-established
    /// subscription keeps serving the old provider until re-connected).
    func reconnect() {
        teardownConnection()
        connectionState = .disconnected
        reconnectAttempt = 0
        reconnectTask?.cancel()
        reconnectTask = nil
        openConnection()
    }

    // MARK: - Subscriptions

    func subscribe(symbols: [String]) {
        let newSymbols = symbols.filter { !subscribedSymbols.contains($0) }
        subscribedSymbols.formUnion(symbols)
        if connectionState == .connected, !newSymbols.isEmpty {
            send(SocketSubscribeMessage(type: "subscribe", symbols: newSymbols))
        }
    }

    func unsubscribe(symbols: [String]) {
        let removed = symbols.filter { subscribedSymbols.contains($0) }
        subscribedSymbols.subtract(symbols)
        for symbol in removed {
            quotes[symbol] = nil
        }
        if connectionState == .connected, !removed.isEmpty {
            send(SocketSubscribeMessage(type: "unsubscribe", symbols: removed))
        }
    }

    // MARK: - Connection management

    private func openConnection() {
        guard connectionState != .connected, connectionState != .connecting else { return }
        connectionState = .connecting
        Task { [weak self] in
            guard let self else { return }
            do {
                let token = try await self.tokenProvider()
                // disconnect() may have fired while we were fetching a token.
                guard self.shouldBeConnected else { return }
                guard var components = URLComponents(url: self.streamURL, resolvingAgainstBaseURL: false) else {
                    throw APIError.invalidRequest
                }
                components.queryItems = [URLQueryItem(name: "token", value: token)]
                guard let url = components.url else {
                    throw APIError.invalidRequest
                }
                let task = self.urlSession.webSocketTask(with: url)
                self.webSocketTask = task
                task.resume()
                self.connectionState = .connected
                self.reconnectAttempt = 0
                if !self.subscribedSymbols.isEmpty {
                    self.send(SocketSubscribeMessage(type: "subscribe", symbols: Array(self.subscribedSymbols)))
                }
                self.startReceiveLoop()
                self.startPingLoop()
            } catch {
                guard !Task.isCancelled else { return }
                self.lastErrorMessage = error.localizedDescription
                self.connectionState = .disconnected
                self.scheduleReconnect()
            }
        }
    }

    private func startReceiveLoop() {
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, let task = self.webSocketTask else { return }
                do {
                    let message = try await task.receive()
                    self.handle(message)
                } catch {
                    if !Task.isCancelled {
                        self.handleUnexpectedDisconnect()
                    }
                    return
                }
            }
        }
    }

    private func startPingLoop() {
        pingTask?.cancel()
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                guard let self, !Task.isCancelled else { return }
                do {
                    try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                        self.webSocketTask?.sendPing { error in
                            if let error { cont.resume(throwing: error) } else { cont.resume() }
                        }
                    }
                } catch {
                    self.handleUnexpectedDisconnect()
                    return
                }
            }
        }
    }

    private func handleUnexpectedDisconnect() {
        teardownConnection()
        connectionState = .disconnected
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard shouldBeConnected, reconnectTask == nil else { return }
        let attempt = reconnectAttempt
        reconnectAttempt += 1
        let backoff = min(0.5 * pow(2.0, Double(attempt)), 30.0)
        let delay = backoff + Double.random(in: 0...0.3)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self, !Task.isCancelled, self.shouldBeConnected else { return }
            self.reconnectTask = nil
            self.openConnection()
        }
    }

    private func teardownConnection() {
        receiveTask?.cancel()
        receiveTask = nil
        pingTask?.cancel()
        pingTask = nil
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
    }

    // MARK: - Wire protocol

    private func send(_ message: SocketSubscribeMessage) {
        guard let data = try? encoder.encode(message), let text = String(data: data, encoding: .utf8) else {
            return
        }
        Task { [weak self] in
            do {
                try await self?.webSocketTask?.send(.string(text))
            } catch {
                self?.lastErrorMessage = error.localizedDescription
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case .string(let text):
            data = Data(text.utf8)
        case .data(let payload):
            data = payload
        @unknown default:
            return
        }
        guard let envelope = try? decoder.decode(SocketEnvelope.self, from: data) else { return }
        switch envelope.type {
        case "quote":
            if let payload = try? decoder.decode(SocketQuoteMessage.self, from: data) {
                let quote = Quote(dto: payload.data)
                quotes[quote.symbol] = quote
                lastQuote = quote
            }
        case "orderUpdate":
            if let payload = try? decoder.decode(SocketOrderUpdateMessage.self, from: data) {
                lastOrderUpdate = OrderResult(dto: payload.data)
            }
        case "error":
            if let payload = try? decoder.decode(SocketErrorMessage.self, from: data) {
                lastErrorMessage = payload.error.message
            }
        default:
            break
        }
    }
}
