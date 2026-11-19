import Foundation
import React

/// React Native bridge for LinkFlowSDK.
///
/// Wraps the canonical Swift SDK (vendored from linkflow-ios-sdk) and exposes
/// it to JavaScript as the `LinkFlowSDK` native module. Caches the most recent
/// attribution result locally so JS callers can fetch it synchronously via
/// `getAttributionResult` even after the originating callback has fired.
@objc(LinkFlowSDKModule)
public class LinkFlowSDKModule: RCTEventEmitter {

    private var hasListeners = false
    private var lastResult: AttributionResult?

    // MARK: - RCTEventEmitter overrides

    @objc public override static func requiresMainQueueSetup() -> Bool { false }

    public override func supportedEvents() -> [String]! {
        return ["LinkFlowAttribution", "LinkFlowDeepLink", "LinkFlowError"]
    }

    public override func startObserving() { hasListeners = true }
    public override func stopObserving()  { hasListeners = false }

    /// `nativeLinkForwarding` is true when the AppDelegate forwards links to
    /// ``LinkFlowLinkForwarder`` (the Expo config plugin sets the Info.plist
    /// flag). JS then skips its own `Linking` listener so links are not handled twice.
    @objc public func constantsToExport() -> [AnyHashable: Any]! {
        [
            "nativeLinkForwarding": Bundle.main.object(forInfoDictionaryKey: "LinkFlowNativeLinkForwarding") as? Bool ?? false,
            "nativeSdkVersion": LinkFlowSDK.sdkVersion,
        ]
    }

    // MARK: - Exposed methods

    @objc(initialize:enableLogging:options:resolver:rejecter:)
    func initialize(_ apiBaseURL: String,
                    enableLogging: Bool,
                    options: NSDictionary?,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        let config = LinkFlowConfig(
            apiBaseURL: apiBaseURL,
            appKey: options?["appKey"] as? String,
            enableLogging: enableLogging,
            requireConsent: options?["requireConsent"] as? Bool ?? false,
            collectAdvertisingID: options?["collectAdvertisingId"] as? Bool ?? true,
            manageConversionValues: options?["manageConversionValues"] as? Bool ?? false
        )
        let sdk = LinkFlowSDK.initialize(config: config)
        attachCallbacks(sdk)
        resolve(nil)
    }

    @objc(setConsent:advertisingId:resolver:rejecter:)
    func setConsent(_ attribution: Bool,
                    advertisingId: Bool,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            try LinkFlowSDK.shared().setConsent(
                LinkFlowConsent(attribution: attribution, advertisingID: advertisingId)
            )
            resolve(nil)
        } catch {
            reject("not_initialized", error.localizedDescription, error)
        }
    }

    @objc(setConsentWithSignals:advertisingId:signals:resolver:rejecter:)
    func setConsentWithSignals(_ attribution: Bool,
                               advertisingId: Bool,
                               signals: NSDictionary?,
                               resolver resolve: @escaping RCTPromiseResolveBlock,
                               rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            try LinkFlowSDK.shared().setConsent(LinkFlowConsent(
                attribution: attribution,
                advertisingID: advertisingId,
                gdprApplies: signals?["gdprApplies"] as? Bool,
                tcfString: signals?["tcfString"] as? String,
                adUserData: signals?["adUserData"] as? Bool,
                adPersonalization: signals?["adPersonalization"] as? Bool
            ))
            resolve(nil)
        } catch {
            reject("not_initialized", error.localizedDescription, error)
        }
    }

    @objc(setCustomerUserId:resolver:rejecter:)
    func setCustomerUserId(_ customerUserId: NSString?,
                           resolver resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            try LinkFlowSDK.shared().setCustomerUserId(customerUserId as String?)
            resolve(nil)
        } catch {
            reject("not_initialized", error.localizedDescription, error)
        }
    }

    @objc(pendingEventCount:rejecter:)
    func pendingEventCount(_ resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            resolve(try LinkFlowSDK.shared().pendingEventCount())
        } catch {
            reject("not_initialized", error.localizedDescription, error)
        }
    }

    @objc(handleAppLaunch:resolver:rejecter:)
    func handleAppLaunch(_ initialUrl: NSString?,
                         resolver resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            let sdk = try LinkFlowSDK.shared()
            // Reattach callbacks (bridge may be recreated across reloads).
            attachCallbacks(sdk)
            let jsURL = LinkFlowLaunchURL.parse(initialUrl as String?)
            let launchURL = LinkFlowLaunchURL.launchURL(
                jsInitialURL: initialUrl as String?,
                captured: LinkFlowLaunchURL.shared.take()
            )
            let firstLaunch = !sdk.diagnostics().attributionComplete

            // Pass the launch URL into launch handling, as Android does. On the
            // first launch the SDK reads its click_token for deterministic
            // attribution; on later launches it delivers the URL as a deep link.
            // This used to pass nil, so the click_token never reached resolve.
            sdk.handleAppLaunch(url: launchURL)

            // 2.1 also delivered the JS launch URL as a direct deep link on the
            // first launch. Keep that. On later launches handleAppLaunch(url:)
            // has delivered it already, so it is not delivered twice.
            if firstLaunch, let jsURL {
                _ = sdk.handleCustomURL(url: jsURL)
            }
            resolve(nil)
        } catch {
            reject("not_initialized", error.localizedDescription, error)
        }
    }

    @objc(handleDeepLink:resolver:rejecter:)
    func handleDeepLink(_ urlString: NSString,
                        resolver resolve: @escaping RCTPromiseResolveBlock,
                        rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let url = URL(string: urlString as String) else {
            reject("invalid_url", "Invalid URL: \(urlString)", nil)
            return
        }
        do {
            let sdk = try LinkFlowSDK.shared()
            // The SDK emits LinkFlowDeepLink through the deep link callback
            // (see attachCallbacks), so the event honours holdDeepLinks().
            _ = sdk.handleCustomURL(url: url)
            resolve(nil)
        } catch {
            reject("not_initialized", error.localizedDescription, error)
        }
    }

    @objc(trackEvent:params:revenue:resolver:rejecter:)
    func trackEvent(_ eventName: NSString,
                    params: NSDictionary?,
                    revenue: NSNumber?,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            let sdk = try LinkFlowSDK.shared()
            sdk.trackEvent(
                eventName: eventName as String,
                params: params as? [String: Any],
                revenue: revenue
            )
            resolve(nil)
        } catch {
            reject("not_initialized", error.localizedDescription, error)
        }
    }

    @objc(getAttributionResult:rejecter:)
    func getAttributionResult(_ resolve: @escaping RCTPromiseResolveBlock,
                              rejecter reject: @escaping RCTPromiseRejectBlock) {
        // Fall back to the SDK's persisted result so a JS reload — which clears
        // this module's in-memory cache — does not lose it.
        var result = lastResult
        if result == nil { result = try? LinkFlowSDK.shared().getAttributionResult() }

        guard let result else {
            resolve(nil)
            return
        }
        resolve(serialize(result))
    }

    @objc(holdDeepLinks:rejecter:)
    func holdDeepLinks(_ resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            try LinkFlowSDK.shared().holdDeepLinks()
            resolve(nil)
        } catch {
            reject("not_initialized", error.localizedDescription, error)
        }
    }

    @objc(releaseDeepLinks:rejecter:)
    func releaseDeepLinks(_ resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            try LinkFlowSDK.shared().releaseDeepLinks()
            resolve(nil)
        } catch {
            reject("not_initialized", error.localizedDescription, error)
        }
    }

    @objc(getDiagnostics:rejecter:)
    func getDiagnostics(_ resolve: @escaping RCTPromiseResolveBlock,
                        rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            resolve(try LinkFlowSDK.shared().getDiagnostics())
        } catch {
            reject("not_initialized", error.localizedDescription, error)
        }
    }

    // MARK: - Internal

    private func attachCallbacks(_ sdk: LinkFlowSDK) {
        sdk.setAttributionCallback { [weak self] result in
            self?.handleResult(result)
        }
        sdk.setDeepLinkCallback { [weak self] url in
            guard let self, self.hasListeners else { return }
            self.sendEvent(withName: "LinkFlowDeepLink", body: ["url": url.absoluteString])
        }
    }

    private func handleResult(_ result: AttributionResult) {
        self.lastResult = result
        if let error = result.error {
            if hasListeners {
                sendEvent(withName: "LinkFlowError", body: ["message": "\(error)"])
            }
            return
        }
        if hasListeners {
            sendEvent(withName: "LinkFlowAttribution", body: serialize(result))
        }
    }

    private func serialize(_ result: AttributionResult) -> [String: Any] {
        var out: [String: Any] = [
            "attributed": result.attributed,
            "deepLinkParams": result.deepLinkParams,
            "campaignData": result.campaignData,
            "isReinstall": result.isReinstall
        ]
        if let v = result.deepLinkValue { out["deepLinkValue"] = v }
        if let m = result.attributionMethod { out["attributionMethod"] = m }
        // -1 is the ObjC-representable stand-in for "no confidence reported".
        if result.confidence >= 0 { out["confidence"] = result.confidence }
        if let match = result.match {
            var m: [String: Any] = ["method": match.method]
            if match.confidence >= 0 { m["confidence"] = match.confidence }
            out["match"] = m
        }
        return out
    }
}

/// Entry point for links received by a running app (2.2.0+).
///
/// The Expo config plugin calls this from the AppDelegate's `open url` and
/// `continue userActivity` methods. Bare apps can add the same calls and set
/// `LinkFlowNativeLinkForwarding` (Boolean, YES) in Info.plist so the JS layer
/// does not also forward the same link.
///
/// A link received before `LinkFlow.initialize()` (a cold start) is kept and
/// handed to `LinkFlow.handleAppLaunch()`, so its click_token is attributed.
@objc(LinkFlowLinkForwarder)
public class LinkFlowLinkForwarder: NSObject {

    @objc(openURL:)
    public static func open(_ url: URL) {
        guard let sdk = try? LinkFlowSDK.shared() else {
            // Before initialize(): keep it so handleAppLaunch can attribute from it.
            LinkFlowLaunchURL.shared.record(url)
            return
        }
        _ = sdk.handleCustomURL(url: url)
    }

    @objc(continueUserActivity:)
    public static func continueUserActivity(_ userActivity: NSUserActivity) {
        guard let sdk = try? LinkFlowSDK.shared() else {
            if userActivity.activityType == NSUserActivityTypeBrowsingWeb, let url = userActivity.webpageURL {
                LinkFlowLaunchURL.shared.record(url)
            }
            return
        }
        _ = sdk.handleUniversalLink(userActivity: userActivity)
    }
}
