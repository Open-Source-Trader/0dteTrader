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

    /// Checks contiguity without advancing the durable checkpoint. The socket
    /// commits only after its synchronous consumer has observed the payload.
    func begin(eventID: String, sequence next: Int) -> DurableCursorDecision {
        guard next > 0 else { return .duplicate }
        guard !seenIDs.contains(eventID), next > sequence else { return .duplicate }
        guard !isResumable || next == sequence + 1 else { return .gap }
        return .accepted
    }

    @discardableResult
    func commit(eventID: String, sequence next: Int) -> Bool {
        guard begin(eventID: eventID, sequence: next) == .accepted else { return false }
        // UserDefaults is written before the in-memory cursor moves, keeping
        // the two checkpoints aligned if persistence ever fails internally.
        persist(sequence: next)
        seenIDs.insert(eventID)
        seenOrder.append(eventID)
        if seenOrder.count > Self.seenLimit {
            seenIDs.remove(seenOrder.removeFirst())
        }
        sequence = next
        return true
    }

    func establish(sequence next: Int) {
        guard next >= sequence else { return }
        persist(sequence: next)
        sequence = next
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

    private func persist(sequence: Int) {
        guard let userID else { return }
        defaults.set(sequence, forKey: key(userID))
        isResumable = true
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
    /// Per-message order delivery. A single @Published slot can coalesce two
    /// back-to-back transitions before SwiftUI renders, so durable events use
    /// direct callbacks and are checkpointed only after this callback returns.
    var onOrderUpdate: ((OrderResult) -> Void)? {
        didSet { drainDurableEvents() }
    }
    /// Server-side chart-order watcher fired, failed, or retired a line.
    ///
    /// A callback, not a `@Published` slot: an OCO fire emits TWO messages
    /// back-to-back (the cancelled sibling, then the fired leg), and a
    /// single-value property observed with `onChange` coalesces them — the
    /// sibling cancellation would be dropped and the dead stop would keep
    /// rendering as a working line. A direct call also delivers with no view
    /// re-render, so watcher pushes land even when the quote stream is idle.
    var onChartOrder: ((ChartOrder) -> Void)? {
        didSet { drainDurableEvents() }
    }

    /// Called when the socket comes back after having been connected before.
    /// Durable events have replayed before this fires; listeners still re-read
    /// aggregate state as an inexpensive consistency check.
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
    private var connectionTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var legacyReadyTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var subscribedSymbols: Set<String> = []
    private var shouldBeConnected = false
    private var reconnectAttempt = 0
    private let durableCursor: DurableEventCursor
    private var connectionGeneration = 0
    private var pendingDurableEvents: [PendingDurableEvent] = []
    private var deferredServerCursor: Int?
    private var isDrainingDurableEvents = false
    private static let maxPendingDurableEvents = 2_048

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
        hasConnected = false
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
        guard shouldBeConnected else { return }
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
        if webSocketTask != nil, !newSymbols.isEmpty {
            send(SocketSubscribeMessage(type: "subscribe", symbols: newSymbols))
        }
    }

    func unsubscribe(symbols: [String]) {
        let removed = symbols.filter { subscribedSymbols.contains($0) }
        subscribedSymbols.subtract(symbols)
        for symbol in removed {
            quotes[symbol] = nil
        }
        if webSocketTask != nil, !removed.isEmpty {
            send(SocketSubscribeMessage(type: "unsubscribe", symbols: removed))
        }
    }

    // MARK: - Connection management

    private func openConnection() {
        guard connectionState != .connected, connectionState != .connecting else { return }
        connectionState = .connecting
        connectionGeneration += 1
        let generation = connectionGeneration
        connectionTask?.cancel()
        connectionTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.connectionGeneration == generation {
                    self.connectionTask = nil
                }
            }
            do {
                let token = try await self.tokenProvider()
                // disconnect()/reconnect may have fired while token refresh was
                // suspended. A generation guard prevents that stale attempt
                // from installing a second authenticated socket afterward.
                guard !Task.isCancelled,
                      self.shouldBeConnected,
                      self.connectionGeneration == generation else { return }
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
                guard self.shouldBeConnected,
                      self.connectionGeneration == generation else {
                    task.cancel(with: .normalClosure, reason: nil)
                    return
                }
                self.webSocketTask = task
                task.resume()
                if !self.subscribedSymbols.isEmpty {
                    self.send(SocketSubscribeMessage(type: "subscribe", symbols: Array(self.subscribedSymbols)))
                }
                // Resume starts transport I/O; remain `.connecting` until an
                // eventCursor proves authentication and replay catch-up. A
                // bounded non-checkpointing fallback supports an old API
                // instance during a rolling deploy.
                self.startReceiveLoop(generation: generation)
                self.startPingLoop(generation: generation)
                self.startLegacyReadyFallback(generation: generation)
            } catch {
                guard !Task.isCancelled,
                      self.shouldBeConnected,
                      self.connectionGeneration == generation else { return }
                self.lastErrorMessage = error.localizedDescription
                self.connectionState = .disconnected
                self.scheduleReconnect()
            }
        }
    }

    private func startReceiveLoop(generation: Int) {
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
                    guard let self,
                          self.connectionGeneration == generation,
                          self.webSocketTask === task else { return }
                    self.publish(decoded)
                } catch {
                    if !Task.isCancelled,
                       let self,
                       self.connectionGeneration == generation,
                       self.webSocketTask === task {
                        self.handleUnexpectedDisconnect()
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
            enqueueDurable(.order(result, eventId, sequence))
        case .chartOrder(let order, let eventId, let sequence):
            enqueueDurable(.chart(order, eventId, sequence))
        case .eventCursor(let sequence):
            deferredServerCursor = max(deferredServerCursor ?? 0, sequence)
            drainDurableEvents()
        case .error(let message):
            lastErrorMessage = message
        }
    }

    private func enqueueDurable(_ event: PendingDurableEvent) {
        guard pendingDurableEvents.count < Self.maxPendingDurableEvents else {
            lastErrorMessage = "Durable event delivery backlog exceeded its safety limit"
            handleUnexpectedDisconnect()
            return
        }
        if let (_, sequence) = event.metadata,
           sequence > 0,
           !durableCursor.isResumable {
            // A fresh connection intentionally skips historical events, but a
            // live event can arrive before SwiftUI installs its callback. Save
            // only the sequence immediately BEFORE that event. If the socket
            // dies while it is queued, reconnect resumes here and replays the
            // unseen payload instead of rebasing past it.
            durableCursor.establish(sequence: sequence - 1)
        }
        pendingDurableEvents.append(event)
        drainDurableEvents()
    }

    private func drainDurableEvents() {
        guard !isDrainingDurableEvents else { return }
        isDrainingDurableEvents = true
        defer { isDrainingDurableEvents = false }

        while let event = pendingDurableEvents.first {
            if let (eventID, sequence) = event.metadata {
                switch durableCursor.begin(eventID: eventID, sequence: sequence) {
                case .duplicate:
                    pendingDurableEvents.removeFirst()
                    continue
                case .gap:
                    lastErrorMessage = "Durable event gap before sequence \(sequence)"
                    handleUnexpectedDisconnect()
                    return
                case .accepted:
                    break
                }
            }

            switch event {
            case .order(let update, _, _):
                guard let onOrderUpdate else { return }
                onOrderUpdate(update)
            case .chart(let order, _, _):
                guard let onChartOrder else { return }
                onChartOrder(order)
            }
            if let (eventID, sequence) = event.metadata,
               !durableCursor.commit(eventID: eventID, sequence: sequence) {
                lastErrorMessage = "Could not commit durable event \(sequence)"
                handleUnexpectedDisconnect()
                return
            }
            // A synchronous consumer is allowed to disconnect/reconnect the
            // socket. Teardown clears this queue; do not removeFirst from the
            // now-empty array after the callback returns.
            if !pendingDurableEvents.isEmpty {
                pendingDurableEvents.removeFirst()
            }
        }

        if let deferredServerCursor {
            durableCursor.establish(sequence: deferredServerCursor)
            self.deferredServerCursor = nil
            markStreamReady()
        }
    }

    private func markStreamReady() {
        guard shouldBeConnected,
              webSocketTask != nil,
              connectionState == .connecting else { return }
        legacyReadyTask?.cancel()
        legacyReadyTask = nil
        connectionState = .connected
        lastErrorMessage = nil
        reconnectAttempt = 0
        let reconnected = hasConnected
        hasConnected = true
        if reconnected { onReconnected?() }
    }

    private func startLegacyReadyFallback(generation: Int) {
        legacyReadyTask?.cancel()
        legacyReadyTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard let self,
                  !Task.isCancelled,
                  self.connectionGeneration == generation,
                  self.webSocketTask != nil,
                  self.connectionState == .connecting,
                  // Receiving eventCursor proves this is a durable server. If
                  // it is deferred behind a queued event awaiting a callback,
                  // stay connecting until replay delivery really completes.
                  self.deferredServerCursor == nil else { return }
            // Pre-cursor servers cannot provide a replay baseline. Become
            // usable without calling establish, so no fake resumable cursor
            // can skip events after the deployment finishes rolling.
            self.markStreamReady()
        }
    }

    private func startPingLoop(generation: Int) {
        pingTask?.cancel()
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                guard let self,
                      !Task.isCancelled,
                      self.connectionGeneration == generation,
                      let socket = self.webSocketTask else { return }
                do {
                    try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                        socket.sendPing { error in
                            if let error { cont.resume(throwing: error) } else { cont.resume() }
                        }
                    }
                } catch {
                    // A cancelled socket's ping callback can arrive after a
                    // forced reconnect has installed its replacement. Never
                    // let that stale callback tear down the new generation.
                    guard !Task.isCancelled,
                          self.connectionGeneration == generation,
                          self.webSocketTask === socket else { return }
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
        connectionGeneration += 1
        connectionTask?.cancel()
        connectionTask = nil
        pendingDurableEvents.removeAll()
        deferredServerCursor = nil
        legacyReadyTask?.cancel()
        legacyReadyTask = nil
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

private enum PendingDurableEvent {
    case order(OrderResult, String?, Int?)
    case chart(ChartOrder, String?, Int?)

    var metadata: (String, Int)? {
        switch self {
        case .order(_, let eventID, let sequence), .chart(_, let eventID, let sequence):
            guard let eventID, let sequence else { return nil }
            return (eventID, sequence)
        }
    }
}
