import Foundation

/// The link that launched the app, for click_token attribution (2.2.0+).
///
/// The iOS SDK reads `click_token` from the URL given to
/// `handleAppLaunch(url:)` on the first launch. The React Native bridge used to
/// call `handleAppLaunch(userActivity: nil)`, so the token never reached the
/// resolve request and deterministic attribution never happened on iOS. Android
/// has always passed the launch URL through.
///
/// A link the OS delivers before `LinkFlow.initialize()` runs (the AppDelegate
/// forwarding added by the Expo config plugin fires before JS starts) is kept
/// here until the bridge's `handleAppLaunch` picks it up.
///
/// Free of React and UIKit so it compiles and is testable without Xcode.
final class LinkFlowLaunchURL {

    static let shared = LinkFlowLaunchURL()

    private let lock = NSLock()
    private var captured: URL?

    /// Records a link received before the SDK was initialized. The first one
    /// wins: it is the link that launched the app.
    func record(_ url: URL) {
        lock.lock(); defer { lock.unlock() }
        if captured == nil { captured = url }
    }

    /// Returns and clears the recorded link.
    func take() -> URL? {
        lock.lock(); defer { lock.unlock() }
        let url = captured
        captured = nil
        return url
    }

    /// The URL to hand to `handleAppLaunch(url:)`: the URL JS reported via
    /// `Linking.getInitialURL()` when present, otherwise one captured natively.
    static func launchURL(jsInitialURL: String?, captured: URL?) -> URL? {
        if let js = parse(jsInitialURL) { return js }
        return captured
    }

    static func parse(_ string: String?) -> URL? {
        guard let string, !string.isEmpty, let url = URL(string: string), url.scheme != nil else { return nil }
        return url
    }
}
