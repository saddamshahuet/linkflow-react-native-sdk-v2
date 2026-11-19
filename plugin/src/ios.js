'use strict';

/**
 * iOS modifications for the LinkFlow Expo config plugin.
 *
 * Every function here is pure (input -> output) and idempotent, so running
 * `expo prebuild` twice yields the same files. The `with*` wiring lives in
 * ./index.js.
 */

const MARKER = '@linkflow/react-native-sdk';
const ASSOCIATED_DOMAINS = 'com.apple.developer.associated-domains';
/** Read by the native module; tells JS not to forward links a second time. */
const FORWARDING_FLAG = 'LinkFlowNativeLinkForwarding';

/** Adds `applinks:<domain>` for each domain, keeping existing entries. */
function addAssociatedDomains(entitlements, domains) {
  if (!domains || domains.length === 0) return entitlements;
  const existing = Array.isArray(entitlements[ASSOCIATED_DOMAINS])
    ? entitlements[ASSOCIATED_DOMAINS]
    : [];
  const merged = [...existing];
  for (const domain of domains) {
    const entry = `applinks:${domain}`;
    if (!merged.includes(entry)) merged.push(entry);
  }
  return { ...entitlements, [ASSOCIATED_DOMAINS]: merged };
}

/** Registers each custom URL scheme unless some CFBundleURLTypes entry already has it. */
function addUrlSchemes(infoPlist, schemes) {
  if (!schemes || schemes.length === 0) return infoPlist;
  const types = Array.isArray(infoPlist.CFBundleURLTypes)
    ? infoPlist.CFBundleURLTypes.map((t) => ({ ...t }))
    : [];
  const known = new Set(types.flatMap((t) => t.CFBundleURLSchemes || []));
  const missing = schemes.filter((s) => !known.has(s));
  if (missing.length > 0) types.push({ CFBundleURLSchemes: missing });
  return { ...infoPlist, CFBundleURLTypes: types };
}

/**
 * Info.plist keys the iOS SDK uses (see the iOS SDK README):
 * - CFBundleURLTypes for the custom scheme;
 * - NSUserTrackingUsageDescription, only when the app asks for ATT
 *   (the SDK itself never shows the prompt);
 * - NSAdvertisingAttributionReportEndpoint (SKAdNetwork) and
 *   AttributionCopyEndpoint (AdAttributionKit, iOS 17.4+), both top-level
 *   string keys per Apple's Information Property List reference, for
 *   developer copies of postbacks on your verified LinkFlow domain;
 * - LinkFlowNativeLinkForwarding when the AppDelegate forwards links.
 */
function applyInfoPlist(infoPlist, props) {
  let out = addUrlSchemes(infoPlist, props.schemes);
  if (props.userTrackingPermission) {
    out = { ...out, NSUserTrackingUsageDescription: props.userTrackingPermission };
  }
  if (props.attributionReportEndpoint) {
    out = {
      ...out,
      NSAdvertisingAttributionReportEndpoint: props.attributionReportEndpoint,
      AttributionCopyEndpoint: props.attributionReportEndpoint,
    };
  }
  if (props.forwardNativeLinks) {
    out = { ...out, [FORWARDING_FLAG]: true };
  } else if (FORWARDING_FLAG in out) {
    out = { ...out };
    delete out[FORWARDING_FLAG];
  }
  return out;
}

function notFound(what, file) {
  return new Error(
    `[${MARKER}] Could not find ${what} in ${file}. Add the LinkFlow forwarding call by hand ` +
      '(see the README section "Bare React Native") and set `forwardNativeLinks: false` in the plugin options.'
  );
}

/**
 * Inserts `line` as the first statement of the method whose signature
 * matches `signature` (a RegExp ending at the opening brace). Skips when
 * `alreadyThere` is present. Throws when the method is missing.
 */
function insertAtMethodStart(src, signature, buildLine, alreadyThere, what, file) {
  if (alreadyThere.test(src)) return src;
  const match = signature.exec(src);
  if (!match) throw notFound(what, file);
  const at = match.index + match[0].length;
  return src.slice(0, at) + '\n' + buildLine(match) + src.slice(at);
}

/** Expo SDK 53+ Swift AppDelegate (`ExpoAppDelegate` subclass). */
function modifySwiftAppDelegate(src) {
  let out = src;
  if (!/^import LinkFlowSDK\s*$/m.test(out)) {
    const imports = [...out.matchAll(/^import [^\n]+\n/gm)];
    if (imports.length === 0) throw notFound('the import block', 'AppDelegate.swift');
    const last = imports[imports.length - 1];
    const at = last.index + last[0].length;
    out = out.slice(0, at) + 'import LinkFlowSDK\n' + out.slice(at);
  }
  out = insertAtMethodStart(
    out,
    /open\s+(\w+)\s*:\s*URL\s*,[^{}]*?\)\s*->\s*Bool\s*\{/,
    (m) => `    LinkFlowLinkForwarder.open(${m[1]}) // ${MARKER}`,
    /LinkFlowLinkForwarder\.open\(/,
    'application(_:open:options:)',
    'AppDelegate.swift'
  );
  out = insertAtMethodStart(
    out,
    /continue\s+(\w+)\s*:\s*NSUserActivity\s*,[^{}]*?\)\s*->\s*Bool\s*\{/,
    (m) => `    LinkFlowLinkForwarder.continueUserActivity(${m[1]}) // ${MARKER}`,
    /LinkFlowLinkForwarder\.continueUserActivity\(/,
    'application(_:continue:restorationHandler:)',
    'AppDelegate.swift'
  );
  return out;
}

/**
 * Objective-C(++) AppDelegate (Expo SDK 52 and older).
 *
 * The forwarder is looked up at runtime rather than through the generated
 * `LinkFlowSDK-Swift.h`: importing a Swift pod's header into an ObjC++ (.mm)
 * file needs C++ modules, which React Native projects do not enable.
 * Messaging a nil class is a no-op, so this is safe if the pod is missing.
 */
function modifyObjcAppDelegate(src) {
  let out = insertAtMethodStart(
    src,
    /openURL:\s*\(\s*NSURL\s*\*\s*\)\s*(\w+)\s+options:[^{}]*\{/,
    (m) =>
      `  [(id)NSClassFromString(@"LinkFlowLinkForwarder") performSelector:@selector(openURL:) withObject:${m[1]}]; // ${MARKER}`,
    /performSelector:@selector\(openURL:\)/,
    'application:openURL:options:',
    'AppDelegate'
  );
  out = insertAtMethodStart(
    out,
    /continueUserActivity:\s*\(\s*(?:nonnull\s+)?NSUserActivity\s*\*\s*\)\s*(\w+)[^{}]*\{/,
    (m) =>
      `  [(id)NSClassFromString(@"LinkFlowLinkForwarder") performSelector:@selector(continueUserActivity:) withObject:${m[1]}]; // ${MARKER}`,
    /performSelector:@selector\(continueUserActivity:\)/,
    'application:continueUserActivity:restorationHandler:',
    'AppDelegate'
  );
  return out;
}

function modifyAppDelegate(src, language) {
  if (language === 'swift') return modifySwiftAppDelegate(src);
  if (language === 'objc' || language === 'objcpp') return modifyObjcAppDelegate(src);
  throw new Error(`[${MARKER}] Unsupported AppDelegate language: ${language}`);
}

module.exports = {
  ASSOCIATED_DOMAINS,
  FORWARDING_FLAG,
  addAssociatedDomains,
  addUrlSchemes,
  applyInfoPlist,
  modifyAppDelegate,
  modifySwiftAppDelegate,
  modifyObjcAppDelegate,
};
