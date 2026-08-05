import Foundation

enum DurableCursorDecision: Equatable {
    case accepted
    case duplicate
    case gap
}

/// Contiguous, per-user stream cursor persisted across launches. The ID set is
/// intentionally session-only and bounded; sequence persistence is the durable
/// duplicate barrier.
final class DurableEventCursor {
    private static let seenLimit = 512
    private let defaults: UserDefaults
    private let serverKey: String
    private var userID: String?
    private(set) var sequence = 0
    private(set) var isResumable = false
    private var seenIDs: Set<String> = []
    private var seenOrder: [String] = []

    init(defaults: UserDefaults, serverKey: String) {
        self.defaults = defaults
        self.serverKey = serverKey
    }

    var retainedEventCount: Int { seenIDs.count }

    func activate(token: String) {
        let nextUserID = Self.jwtSubject(token)
        guard nextUserID != userID else { return }
        userID = nextUserID
        seenIDs.removeAll()
        seenOrder.removeAll()
        guard let nextUserID else {
            sequence = 0
            isResumable = false
            return
        }
        let cursorKey = key(nextUserID)
        isResumable = defaults.object(forKey: cursorKey) != nil
        sequence = max(0, defaults.integer(forKey: cursorKey))
    }

    func accept(eventID: String, sequence next: Int) -> DurableCursorDecision {
        guard next > 0 else { return .duplicate }
        guard !seenIDs.contains(eventID), next > sequence else { return .duplicate }
        guard !isResumable || next == sequence + 1 else { return .gap }
        seenIDs.insert(eventID)
        seenOrder.append(eventID)
        if seenOrder.count > Self.seenLimit {
            seenIDs.remove(seenOrder.removeFirst())
        }
        sequence = next
        persist()
        return .accepted
    }

    func establish(sequence next: Int) {
        guard next >= sequence else { return }
        sequence = next
        persist()
    }

    func resetSession() {
        userID = nil
        sequence = 0
        isResumable = false
        seenIDs.removeAll()
        seenOrder.removeAll()
    }

    private func key(_ userID: String) -> String {
        "events.cursor.v1:\(serverKey):\(userID)"
    }

    private func persist() {
        guard let userID else { return }
        isResumable = true
        defaults.set(sequence, forKey: key(userID))
    }

    private static func jwtSubject(_ token: String) -> String? {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count > 1 else { return nil }
        var encoded = String(parts[1]).replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        guard let data = Data(base64Encoded: encoded),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let subject = object["sub"] as? String,
              !subject.isEmpty else { return nil }
        return subject
    }
}

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
    /// Server-side chart-order watcher fired, failed, or retired a line.
    ///
    /// A callback, not a `@Published` slot: an OCO fire emits TWO messages
    /// back-to-back (the cancelled sibling, then the fired leg), and a
    /// single-value property observed with `onChange` coalesces them — the
    /// sibling cancellation would be dropped and the dead stop would keep
    /// rendering as a working line. A direct call also delivers with no view
    /// re-render, so watcher pushes land even when the quote stream is idle.
    var onChartOrder: ((ChartOrder) -> Void)?

    /// Called when the socket comes back after having been connected before.
    /// Anything pushed while it was down was missed outright, so listeners must
    /// re-read whatever state the stream keeps current.
    var onReconnected: (() -> Void)?

    /// Whether a connection was ever established, so the next `.connected`
    /// transition is a RE-connection with a gap to make up.
    private var hasConnected = false
    @Published private(set) var lastErrorMessage: String?

    private let streamURL: URL
    private let tokenProvider: () async throws -> String
    private let encoder = JSONEncoder()
    private let urlSession: URLSession

    private var webSocketTask: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var subscribedSymbols: Set<String> = []
    private var shouldBeConnected = false
    private var reconnectAttempt = 0
    private let durableCursor: DurableEventCursor

    init(
        streamURL: URL,
        urlSession: URLSession = .shared,
        cursorDefaults: UserDefaults = .standard,
        tokenProvider: @escaping () async throws -> String
    ) {
        self.streamURL = streamURL
        self.urlSession = urlSession
        self.tokenProvider = tokenProvider
        self.durableCursor = DurableEventCursor(defaults: cursorDefaults, serverKey: streamURL.absoluteString)
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
        durableCursor.resetSession()
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
                self.durableCursor.activate(token: token)
                guard var components = URLComponents(url: self.streamURL, resolvingAgainstBaseURL: false) else {
                    throw APIError.invalidRequest
                }
                var queryItems = components.queryItems ?? []
                queryItems.removeAll { $0.name == "token" || $0.name == "cursor" }
                queryItems.append(URLQueryItem(name: "token", value: token))
                if self.durableCursor.isResumable {
                    queryItems.append(URLQueryItem(name: "cursor", value: String(self.durableCursor.sequence)))
                }
                components.queryItems = queryItems
                guard let url = components.url else {
                    throw APIError.invalidRequest
                }
                let task = self.urlSession.webSocketTask(with: url)
                self.webSocketTask = task
                task.resume()
                self.connectionState = .connected
                self.reconnectAttempt = 0
                let reconnected = self.hasConnected
                self.hasConnected = true
                if reconnected { self.onReconnected?() }
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
            guard let task = self?.webSocketTask else { return }
            while !Task.isCancelled {
                do {
                    let message = try await task.receive()
                    // Decoding runs off the main actor so a burst of quotes
                    // can't queue up behind SwiftUI layout/gesture work; only
                    // the resulting @Published writes hop back to it.
                    guard let decoded = await Self.decode(message) else { continue }
                    guard let self else { return }
                    self.publish(decoded)
                } catch {
                    if !Task.isCancelled {
                        self?.handleUnexpectedDisconnect()
                    }
                    return
                }
            }
        }
    }

    private nonisolated static func decode(_ message: URLSessionWebSocketTask.Message) async -> DecodedSocketMessage? {
        let data: Data
        switch message {
        case .string(let text):
            data = Data(text.utf8)
        case .data(let payload):
            data = payload
        @unknown default:
            return nil
        }
        let decoder = JSONDecoder()
        guard let envelope = try? decoder.decode(SocketEnvelope.self, from: data) else { return nil }
        switch envelope.type {
        case "quote":
            guard let payload = try? decoder.decode(SocketQuoteMessage.self, from: data) else { return nil }
            return .quote(Quote(dto: payload.data))
        case "orderUpdate":
            guard let payload = try? decoder.decode(SocketOrderUpdateMessage.self, from: data) else { return nil }
            return .orderUpdate(OrderResult(dto: payload.data), payload.eventId, payload.sequence)
        case "chartOrder":
            guard let payload = try? decoder.decode(SocketChartOrderMessage.self, from: data),
                  let order = ChartOrder(dto: payload.data) else { return nil }
            return .chartOrder(order, payload.eventId, payload.sequence)
        case "eventCursor":
            guard let payload = try? decoder.decode(SocketEventCursorMessage.self, from: data) else { return nil }
            return .eventCursor(payload.sequence)
        case "error":
            guard let payload = try? decoder.decode(SocketErrorMessage.self, from: data) else { return nil }
            return .error(payload.error.message)
        default:
            return nil
        }
    }

    private func publish(_ decoded: DecodedSocketMessage) {
        switch decoded {
        case .quote(let quote):
            quotes[quote.symbol] = quote
            lastQuote = quote
        case .orderUpdate(let result, let eventId, let sequence):
            guard acceptDurable(eventId: eventId, sequence: sequence) else { return }
            lastOrderUpdate = result
        case .chartOrder(let order, let eventId, let sequence):
            guard acceptDurable(eventId: eventId, sequence: sequence) else { return }
            onChartOrder?(order)
        case .eventCursor(let sequence):
            durableCursor.establish(sequence: sequence)
        case .error(let message):
            lastErrorMessage = message
        }
    }

    private func acceptDurable(eventId: String?, sequence: Int?) -> Bool {
        // Older servers/tests have no metadata. They remain readable during a
        // rolling deploy, while new durable events use bounded id de-duplication.
        guard let eventId, let sequence else { return true }
        switch durableCursor.accept(eventID: eventId, sequence: sequence) {
        case .accepted:
            return true
        case .duplicate:
            return false
        case .gap:
            handleUnexpectedDisconnect()
            return false
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

}

private enum DecodedSocketMessage {
    case quote(Quote)
    case orderUpdate(OrderResult, String?, Int?)
    case chartOrder(ChartOrder, String?, Int?)
    case eventCursor(Int)
    case error(String)
}
