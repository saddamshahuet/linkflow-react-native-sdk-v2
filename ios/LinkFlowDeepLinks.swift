import Foundation

// Platform-independent pieces of the 2.2.0 features (deep link hold/release,
// match info, diagnostics). Kept free of UIKit and the Objective-C runtime so
// they compile and unit-test on Linux CI, like LinkFlowCore.swift.

// MARK: - Deep link hold / release

/// The two ways a deep link reaches the app.
public enum DeepLinkKind: Hashable {
    /// Resolved after install by the attribution request (an attributed result carrying a link).
    case deferred
    /// Opened while the app is installed: universal link, custom scheme.
    case direct
}

/// Holds deep-link deliveries while the host app cannot navigate (2.2.0+).
///
/// Bounded: only the latest item of each ``DeepLinkKind`` is kept, so several
/// taps while held produce one navigation per kind on release. ``release()``
/// returns the kept items in arrival order.
public final class DeepLinkHoldQueue<Item> {

    private let lock = NSLock()
    private var held = false
    private var pending: [(kind: DeepLinkKind, item: Item)] = []

    public init() {}

    public func hold() {
        lock.lock(); defer { lock.unlock() }
        held = true
    }

    public var isHeld: Bool {
        lock.lock(); defer { lock.unlock() }
        return held
    }

    /// Number of deliveries waiting for release (at most one per kind).
    public var count: Int {
        lock.lock(); defer { lock.unlock() }
        return pending.count
    }

    /// Queues `item` when held. Returns true when queued, in which case the
    /// caller must not deliver it now; false means "not held, deliver now".
    @discardableResult
    public func offer(_ kind: DeepLinkKind, _ item: Item) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard held else { return false }
        pending.removeAll { $0.kind == kind }
        pending.append((kind, item))
        return true
    }

    /// Stops holding and hands back what was queued, oldest arrival first.
    public func release() -> [Item] {
        lock.lock(); defer { lock.unlock() }
        held = false
        let out = pending.map { $0.item }
        pending.removeAll()
        return out
    }
}

// MARK: - Match info

/// How the server matched the install (2.2.0+), from the resolve response's
/// optional `match` object. Absent when talking to an older server.
public struct ParsedMatch: Equatable {
    /// "install_referrer", "click_token", "advertising_id", "probabilistic" or "organic".
    public let method: String
    /// 0.0–1.0 when reported.
    public let confidence: Double?

    public init(method: String, confidence: Double?) {
        self.method = method
        self.confidence = confidence
    }

    public init?(json: Any?) {
        guard let dict = json as? [String: Any],
              let method = dict["method"] as? String, !method.isEmpty else { return nil }
        self.method = method
        if let d = dict["confidence"] as? Double {
            self.confidence = d
        } else if let n = dict["confidence"] as? NSNumber {
            self.confidence = n.doubleValue
        } else {
            self.confidence = nil
        }
    }
}

// MARK: - Diagnostics

/// Coarse outcome of the last attribution request. Never carries identifiers.
public enum ResolveResultCategory: String {
    case attributed
    case organic
    /// The server answered 4xx; the SDK does not retry.
    case rejected
    /// Network error, timeout or 5xx; retried on the next launch.
    case networkError = "network_error"
    /// 2xx with a body the SDK could not read.
    case invalidResponse = "invalid_response"
}

/// Support snapshot of the SDK's state (2.2.0+).
///
/// Answers "why didn't my deep link fire?" without exposing anything that
/// identifies the user or device: no install id, token, IDFA/IDFV, customer
/// user id, click token or app key — only whether they exist.
public struct LinkFlowDiagnostics {
    public var sdkVersion: String
    public var platform: String = "ios"
    /// Host of the configured API base URL. Never the full URL.
    public var apiHost: String?
    public var appKeyConfigured: Bool
    /// "not_required", "pending", "granted" or "denied".
    public var consentState: String
    public var advertisingIDConsent: Bool?
    public var launchPendingConsent: Bool
    public var hasInstallID: Bool
    public var hasInstallToken: Bool
    public var customerUserIDSet: Bool
    public var attributionComplete: Bool
    public var lastResolveAt: Date?
    public var lastResolveResult: ResolveResultCategory?
    public var lastMatchMethod: String?
    public var queuedEventCount: Int
    public var deepLinksHeld: Bool
    public var heldDeepLinkCount: Int
    public var attributionCallbackSet: Bool

    public init(
        sdkVersion: String,
        apiHost: String?,
        appKeyConfigured: Bool,
        consentState: String,
        advertisingIDConsent: Bool?,
        launchPendingConsent: Bool,
        hasInstallID: Bool,
        hasInstallToken: Bool,
        customerUserIDSet: Bool,
        attributionComplete: Bool,
        lastResolveAt: Date?,
        lastResolveResult: ResolveResultCategory?,
        lastMatchMethod: String?,
        queuedEventCount: Int,
        deepLinksHeld: Bool,
        heldDeepLinkCount: Int,
        attributionCallbackSet: Bool
    ) {
        self.sdkVersion = sdkVersion
        self.apiHost = apiHost
        self.appKeyConfigured = appKeyConfigured
        self.consentState = consentState
        self.advertisingIDConsent = advertisingIDConsent
        self.launchPendingConsent = launchPendingConsent
        self.hasInstallID = hasInstallID
        self.hasInstallToken = hasInstallToken
        self.customerUserIDSet = customerUserIDSet
        self.attributionComplete = attributionComplete
        self.lastResolveAt = lastResolveAt
        self.lastResolveResult = lastResolveResult
        self.lastMatchMethod = lastMatchMethod
        self.queuedEventCount = queuedEventCount
        self.deepLinksHeld = deepLinksHeld
        self.heldDeepLinkCount = heldDeepLinkCount
        self.attributionCallbackSet = attributionCallbackSet
    }

    /// JSON-friendly dictionary with the same keys as the Android and React Native SDKs.
    /// Absent optional values are omitted.
    public var dictionary: [String: Any] {
        var out: [String: Any] = [
            "sdkVersion": sdkVersion,
            "platform": platform,
            "appKeyConfigured": appKeyConfigured,
            "consentState": consentState,
            "launchPendingConsent": launchPendingConsent,
            "hasInstallId": hasInstallID,
            "hasInstallToken": hasInstallToken,
            "customerUserIdSet": customerUserIDSet,
            "attributionComplete": attributionComplete,
            "queuedEventCount": queuedEventCount,
            "deepLinksHeld": deepLinksHeld,
            "heldDeepLinkCount": heldDeepLinkCount,
            "attributionCallbackSet": attributionCallbackSet,
        ]
        if let apiHost { out["apiHost"] = apiHost }
        if let advertisingIDConsent { out["advertisingIdConsent"] = advertisingIDConsent }
        if let lastResolveAt { out["lastResolveAt"] = LinkFlowTimestamp.iso8601(lastResolveAt) }
        if let lastResolveResult { out["lastResolveResult"] = lastResolveResult.rawValue }
        if let lastMatchMethod { out["lastMatchMethod"] = lastMatchMethod }
        return out
    }

    /// Host only; nil for an unparseable URL. Never returns path, query or credentials.
    public static func host(of url: String) -> String? {
        guard let host = URLComponents(string: url.trimmingCharacters(in: .whitespaces))?.host,
              !host.isEmpty else { return nil }
        return host
    }

    public static func consentState(requireConsent: Bool, consent: LinkFlowConsent?) -> String {
        guard let consent else { return "pending" }
        if !consent.attribution { return "denied" }
        return requireConsent ? "granted" : "not_required"
    }
}
