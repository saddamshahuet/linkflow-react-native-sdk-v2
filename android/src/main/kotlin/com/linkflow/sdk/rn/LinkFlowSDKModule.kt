package com.linkflow.sdk.rn

import android.content.Intent
import android.net.Uri
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.linkflow.sdk.LinkFlowConfig
import com.linkflow.sdk.LinkFlowConsent
import com.linkflow.sdk.LinkFlowSDK

/**
 * React Native bridge for the canonical Android LinkFlow SDK.
 *
 * Wraps the vendored [LinkFlowSDK] and exposes it as the `LinkFlowSDK`
 * native module on the JS side. Caches the most recent attribution result
 * so JS callers can fetch it via [getAttributionResult] without waiting for
 * another callback.
 */
class LinkFlowSDKModule(
    private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext), LinkFlowSDK.AttributionCallback {

    private var lastResult: LinkFlowSDK.AttributionResult? = null

    override fun getName(): String = NAME

    @ReactMethod
    fun initialize(apiBaseURL: String, enableLogging: Boolean, options: ReadableMap?, promise: Promise) {
        try {
            val config = LinkFlowConfig(
                apiBaseUrl = apiBaseURL,
                appKey = options?.takeIf { it.hasKey("appKey") }?.getString("appKey"),
                enableLogging = enableLogging,
                requireConsent = options?.takeIf { it.hasKey("requireConsent") }
                    ?.getBoolean("requireConsent") ?: false,
                collectAdvertisingId = options?.takeIf { it.hasKey("collectAdvertisingId") }
                    ?.getBoolean("collectAdvertisingId") ?: true,
            )
            val sdk = LinkFlowSDK.initialize(reactContext.applicationContext, config)
            sdk.setAttributionCallback(this)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("init_failed", e.message, e)
        }
    }

    @ReactMethod
    fun setConsent(attribution: Boolean, advertisingId: Boolean, promise: Promise) {
        try {
            LinkFlowSDK.getInstance().setConsent(
                LinkFlowConsent(attribution = attribution, advertisingId = advertisingId)
            )
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("set_consent_failed", e.message, e)
        }
    }

    @ReactMethod
    fun pendingEventCount(promise: Promise) {
        try {
            promise.resolve(LinkFlowSDK.getInstance().pendingEventCount())
        } catch (e: Exception) {
            promise.reject("pending_count_failed", e.message, e)
        }
    }

    @ReactMethod
    fun handleAppLaunch(initialUrl: String?, promise: Promise) {
        try {
            val sdk = LinkFlowSDK.getInstance()
            sdk.setAttributionCallback(this)

            // If JS supplied a launch URL, wrap it in a synthetic Intent so the
            // canonical SDK's first-launch attribution path can extract the
            // click_token query parameter.
            val intent: Intent? = if (!initialUrl.isNullOrEmpty()) {
                Intent(Intent.ACTION_VIEW, Uri.parse(initialUrl))
            } else {
                currentActivity?.intent
            }
            sdk.handleAppLaunch(intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("handle_app_launch_failed", e.message, e)
        }
    }

    @ReactMethod
    fun handleDeepLink(url: String, promise: Promise) {
        try {
            // Routes through the SDK, which emits onDeepLinkReceived back to us.
            // This used to emit the JS event directly because the Android SDK had
            // no public deep-link entry point — so anything the SDK does with a
            // deep link (and any future handling) was skipped on Android while
            // working on iOS.
            LinkFlowSDK.getInstance().handleDeepLink(Uri.parse(url))
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("handle_deeplink_failed", e.message, e)
        }
    }

    @ReactMethod
    fun trackEvent(eventName: String, params: ReadableMap?, revenue: Double?, promise: Promise) {
        try {
            val map = params?.toHashMap()
            LinkFlowSDK.getInstance().trackEvent(eventName, map, revenue)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("track_event_failed", e.message, e)
        }
    }

    @ReactMethod
    fun getAttributionResult(promise: Promise) {
        try {
            // Fall back to the SDK's persisted result so a JS reload — which
            // clears this module's in-memory cache — does not lose it.
            val r = lastResult ?: LinkFlowSDK.getInstance().getAttributionResult()
            if (r == null) {
                promise.resolve(null)
            } else {
                promise.resolve(serializeResult(r))
            }
        } catch (e: Exception) {
            promise.reject("get_result_failed", e.message, e)
        }
    }

    // RN's NativeEventEmitter expects these to exist on the native module.
    @ReactMethod fun addListener(eventName: String) { /* no-op */ }
    @ReactMethod fun removeListeners(count: Int) { /* no-op */ }

    // ----- AttributionCallback -----

    override fun onAttributionResolved(result: LinkFlowSDK.AttributionResult) {
        lastResult = result
        emit(EVENT_ATTRIBUTION, serializeResult(result))
    }

    override fun onAttributionError(error: Throwable) {
        val map = Arguments.createMap()
        map.putString("message", error.message ?: "unknown error")
        emit(EVENT_ERROR, map)
    }

    override fun onDeepLinkReceived(uri: Uri) {
        val map = Arguments.createMap()
        map.putString("url", uri.toString())
        emit(EVENT_DEEPLINK, map)
    }

    // ----- Helpers -----

    private fun emit(name: String, body: WritableMap) {
        if (!reactContext.hasActiveReactInstance()) return
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(name, body)
    }

    private fun serializeResult(r: LinkFlowSDK.AttributionResult): WritableMap {
        val map = Arguments.createMap()
        map.putBoolean("attributed", r.attributed)
        if (r.deepLinkValue != null) map.putString("deepLinkValue", r.deepLinkValue)
        map.putMap("deepLinkParams", mapToWritable(r.deepLinkParams))
        map.putMap("campaignData", mapToWritable(r.campaignData))
        if (r.attributionMethod != null) map.putString("attributionMethod", r.attributionMethod)
        if (r.confidence != null) map.putDouble("confidence", r.confidence)
        map.putBoolean("isReinstall", r.isReinstall)
        return map
    }

    @Suppress("UNCHECKED_CAST")
    private fun mapToWritable(input: Map<String, Any?>): WritableMap {
        val out = Arguments.createMap()
        for ((k, v) in input) {
            when (v) {
                null -> out.putNull(k)
                is String -> out.putString(k, v)
                is Boolean -> out.putBoolean(k, v)
                is Int -> out.putInt(k, v)
                is Long -> out.putDouble(k, v.toDouble())
                is Double -> out.putDouble(k, v)
                is Float -> out.putDouble(k, v.toDouble())
                is Map<*, *> -> out.putMap(k, mapToWritable(v as Map<String, Any?>))
                else -> out.putString(k, v.toString())
            }
        }
        return out
    }

    companion object {
        const val NAME = "LinkFlowSDK"
        private const val EVENT_ATTRIBUTION = "LinkFlowAttribution"
        private const val EVENT_DEEPLINK = "LinkFlowDeepLink"
        private const val EVENT_ERROR = "LinkFlowError"
    }
}
