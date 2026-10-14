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
        sdk.setAttributionCallback { [weak self] result in
            self?.handleResult(result)
        }
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
            // Reattach callback (bridge may be recreated across reloads).
            sdk.setAttributionCallback { [weak self] result in
                self?.handleResult(result)
            }
            sdk.handleAppLaunch(userActivity: nil)
            // If a launch URL is provided, treat it as a custom-scheme deep link.
            if let urlString = initialUrl as String?,
               !urlString.isEmpty,
               let url = URL(string: urlString) {
                _ = sdk.handleCustomURL(url: url)
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
            _ = sdk.handleCustomURL(url: url)
            // Also emit a JS-level deep-link event for consumers that want
            // raw URL notifications independent of attribution callbacks.
            if hasListeners {
                sendEvent(withName: "LinkFlowDeepLink", body: ["url": url.absoluteString])
            }
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

    // MARK: - Internal

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
        return out
    }
}
