'use strict';

/**
 * Expo config plugin for @linkflow/react-native-sdk (2.2.0+).
 *
 * app.json:
 *   "plugins": [["@linkflow/react-native-sdk", {
 *     "domains": ["go.example.com"],
 *     "scheme": "myapp"
 *   }]]
 *
 * iOS: Associated Domains (`applinks:<domain>`), URL scheme, optional
 * Info.plist keys, and AppDelegate forwarding of `open url` /
 * `continue userActivity` to the SDK (Swift for Expo SDK 53+, Objective-C
 * for SDK 52 and older).
 * Android: `autoVerify` App Links intent filters, the scheme filter, and
 * `onNewIntent` forwarding in MainActivity (Kotlin or Java).
 *
 * Every modification is idempotent: running `expo prebuild` again does not
 * duplicate anything.
 */

const {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidManifest,
  withAppDelegate,
  withEntitlementsPlist,
  withInfoPlist,
  withMainActivity,
} = require('@expo/config-plugins');

const ios = require('./ios');
const android = require('./android');

const pkg = { name: '@linkflow/react-native-sdk', version: '2.2.0' };

function toList(value) {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).filter((v) => typeof v === 'string' && v.trim());
}

/** Accepts `go.example.com` or `https://go.example.com/`; returns the bare host. */
function normalizeDomain(input) {
  const host = input
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
  if (!/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/.test(host)) {
    throw new Error(`[${pkg.name}] "${input}" is not a valid link domain (expected e.g. "go.example.com").`);
  }
  return host;
}

function normalizeScheme(input) {
  const scheme = input.trim().replace(/:\/*$/, '');
  if (!/^[a-z][a-z0-9+.-]*$/i.test(scheme)) {
    throw new Error(`[${pkg.name}] "${input}" is not a valid URL scheme (expected e.g. "myapp").`);
  }
  return scheme;
}

/**
 * @typedef {object} LinkFlowPluginProps
 * @property {string|string[]} [domains]  LinkFlow link domains for universal links / App Links.
 * @property {string|string[]} [scheme]   Custom URL scheme(s). Defaults to app.json `scheme`.
 * @property {boolean} [forwardNativeLinks=true]  Forward links from AppDelegate / MainActivity.
 * @property {string} [userTrackingPermission]  NSUserTrackingUsageDescription, if your app requests ATT.
 * @property {string} [attributionReportEndpoint]  https URL of your verified LinkFlow domain for
 *   SKAdNetwork / AdAttributionKit postback copies.
 * @property {boolean} [androidAutoVerify=true]  `android:autoVerify` on the App Links filter.
 */
function normalizeProps(props = {}, config = {}) {
  const schemes = toList(props.scheme).length > 0 ? toList(props.scheme) : toList(config.scheme);
  if (props.attributionReportEndpoint && !/^https:\/\//.test(props.attributionReportEndpoint)) {
    throw new Error(`[${pkg.name}] attributionReportEndpoint must be an https URL.`);
  }
  return {
    domains: [...new Set(toList(props.domains).map(normalizeDomain))],
    schemes: [...new Set(schemes.map(normalizeScheme))],
    forwardNativeLinks: props.forwardNativeLinks !== false,
    userTrackingPermission: props.userTrackingPermission,
    attributionReportEndpoint: props.attributionReportEndpoint,
    androidAutoVerify: props.androidAutoVerify !== false,
  };
}

const withLinkFlowIos = (config, props) => {
  config = withEntitlementsPlist(config, (c) => {
    c.modResults = ios.addAssociatedDomains(c.modResults, props.domains);
    return c;
  });
  config = withInfoPlist(config, (c) => {
    c.modResults = ios.applyInfoPlist(c.modResults, props);
    return c;
  });
  if (props.forwardNativeLinks) {
    config = withAppDelegate(config, (c) => {
      c.modResults.contents = ios.modifyAppDelegate(c.modResults.contents, c.modResults.language);
      return c;
    });
  }
  return config;
};

const withLinkFlowAndroid = (config, props) => {
  config = withAndroidManifest(config, (c) => {
    const manifest = c.modResults;
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);

    const updatedActivity = android.addIntentFilters(activity, {
      domains: props.domains,
      schemes: props.schemes,
      autoVerify: props.androidAutoVerify,
    });
    activity['intent-filter'] = updatedActivity['intent-filter'];
    application['meta-data'] = android.setForwardingMetaData(
      application,
      props.forwardNativeLinks
    )['meta-data'];
    return c;
  });
  if (props.forwardNativeLinks) {
    config = withMainActivity(config, (c) => {
      c.modResults.contents = android.modifyMainActivity(c.modResults.contents, c.modResults.language);
      return c;
    });
  }
  return config;
};

const withLinkFlow = (config, rawProps) => {
  const props = normalizeProps(rawProps, config);
  config = withLinkFlowIos(config, props);
  config = withLinkFlowAndroid(config, props);
  return config;
};

module.exports = createRunOncePlugin(withLinkFlow, pkg.name, pkg.version);
module.exports.withLinkFlow = withLinkFlow;
module.exports.normalizeProps = normalizeProps;
