package com.linkflow.sdk.rn

import android.content.Intent
import com.linkflow.sdk.LinkFlowSDK

/**
 * Entry point for links received by a running app (2.2.0+).
 *
 * The Expo config plugin calls this from `MainActivity.onNewIntent`. Bare apps
 * can add the same call:
 * ```
 * override fun onNewIntent(intent: Intent) {
 *   super.onNewIntent(intent)
 *   LinkFlowLinkForwarder.onNewIntent(intent)
 * }
 * ```
 * and set the `com.linkflow.sdk.NATIVE_LINK_FORWARDING` meta-data to true so
 * the JS layer does not also forward the same link.
 *
 * Does nothing before `LinkFlow.initialize()`. A cold-start link is picked up
 * by `LinkFlow.handleAppLaunch()` instead.
 */
object LinkFlowLinkForwarder {
    @JvmStatic
    fun onNewIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW || intent.data == null) return
        try {
            LinkFlowSDK.getInstance().handleDeepLink(intent)
        } catch (e: IllegalStateException) {
            // Not initialized yet. handleAppLaunch() reads the launch URL instead.
        }
    }
}
