/**
 * Tests for the Expo config plugin.
 *
 * Fixtures are the unmodified templates from `expo-template-bare-minimum`
 * (0BSD): sdk-54 AppDelegate.swift / MainActivity.kt / AndroidManifest.xml and
 * sdk-52 AppDelegate.mm. They exercise the real code the plugin edits.
 */
const fs = require('fs');
const path = require('path');
const { AndroidConfig } = require('@expo/config-plugins');

const plugin = require('../../app.plugin');
const ios = require('../src/ios');
const android = require('../src/android');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const count = (haystack, needle) => haystack.split(needle).length - 1;

const PROPS = {
  domains: ['go.example.com', 'https://Links.Example.org/'],
  scheme: 'myapp',
  userTrackingPermission: 'Used to measure ad performance.',
  attributionReportEndpoint: 'https://go.example.com',
};

/** Runs the mod the plugin registered for `platform.name` on `modResults`. */
async function runMod(config, platform, name, modResults) {
  const mod = config.mods && config.mods[platform] && config.mods[platform][name];
  if (!mod) throw new Error(`no ${platform}.${name} mod registered`);
  const result = await mod({
    ...config,
    modResults,
    modRequest: {
      projectRoot: '/tmp/project',
      platformProjectRoot: `/tmp/project/${platform}`,
      modName: name,
      platform,
      introspect: false,
    },
  });
  return result.modResults;
}

describe('props', () => {
  it('normalises domains and falls back to the app.json scheme', () => {
    const props = plugin.normalizeProps({ domains: ['https://Go.Example.com/path'] }, { scheme: 'fromconfig' });
    expect(props.domains).toEqual(['go.example.com']);
    expect(props.schemes).toEqual(['fromconfig']);
    expect(props.forwardNativeLinks).toBe(true);
  });

  it('rejects invalid values', () => {
    expect(() => plugin.normalizeProps({ domains: ['not a domain'] })).toThrow(/valid link domain/);
    expect(() => plugin.normalizeProps({ scheme: '1bad' })).toThrow(/valid URL scheme/);
    expect(() => plugin.normalizeProps({ attributionReportEndpoint: 'http://x.example.com' })).toThrow(/https/);
  });
});

describe('iOS', () => {
  it('adds associated domains once', () => {
    const once = ios.addAssociatedDomains({ [ios.ASSOCIATED_DOMAINS]: ['applinks:other.example.com'] }, [
      'go.example.com',
    ]);
    const twice = ios.addAssociatedDomains(once, ['go.example.com']);
    expect(twice[ios.ASSOCIATED_DOMAINS]).toEqual(['applinks:other.example.com', 'applinks:go.example.com']);
  });

  it('writes the Info.plist keys the iOS SDK uses, idempotently', () => {
    const props = plugin.normalizeProps(PROPS);
    const start = { CFBundleURLTypes: [{ CFBundleURLSchemes: ['com.example.app'] }] };
    const once = ios.applyInfoPlist(start, props);
    const twice = ios.applyInfoPlist(once, props);
    expect(twice).toEqual(once);
    expect(once.CFBundleURLTypes).toEqual([
      { CFBundleURLSchemes: ['com.example.app'] },
      { CFBundleURLSchemes: ['myapp'] },
    ]);
    expect(once.NSUserTrackingUsageDescription).toBe('Used to measure ad performance.');
    expect(once.NSAdvertisingAttributionReportEndpoint).toBe('https://go.example.com');
    expect(once.AttributionCopyEndpoint).toBe('https://go.example.com');
    expect(once.LinkFlowNativeLinkForwarding).toBe(true);
  });

  it('leaves optional keys out when not configured and clears the flag when forwarding is off', () => {
    const plist = ios.applyInfoPlist(
      { LinkFlowNativeLinkForwarding: true },
      plugin.normalizeProps({ forwardNativeLinks: false })
    );
    expect(plist.NSUserTrackingUsageDescription).toBeUndefined();
    expect(plist.AttributionCopyEndpoint).toBeUndefined();
    expect(plist.LinkFlowNativeLinkForwarding).toBeUndefined();
  });

  it('forwards links from the Expo SDK 53+ Swift AppDelegate', () => {
    const src = fixture('AppDelegate.sdk54.swift');
    const out = ios.modifySwiftAppDelegate(src);

    expect(out).toMatch(/import ReactAppDependencyProvider\nimport LinkFlowSDK\n/);
    expect(out).toMatch(
      /options: \[UIApplication\.OpenURLOptionsKey: Any\] = \[:\]\n  \) -> Bool \{\n    LinkFlowLinkForwarder\.open\(url\) \/\/ @linkflow\/react-native-sdk\n    return super\.application\(app, open: url/
    );
    expect(out).toMatch(
      /restorationHandler: @escaping \(\[UIUserActivityRestoring\]\?\) -> Void\n  \) -> Bool \{\n    LinkFlowLinkForwarder\.continueUserActivity\(userActivity\) \/\/ @linkflow\/react-native-sdk\n    let result = RCTLinkingManager/
    );
    // Untouched otherwise: removing the inserted lines gives back the template.
    const stripped = out
      .split('\n')
      .filter((l) => !l.includes('LinkFlowLinkForwarder') && l !== 'import LinkFlowSDK')
      .join('\n');
    expect(stripped).toBe(src);
  });

  it('is idempotent on the Swift AppDelegate', () => {
    const once = ios.modifySwiftAppDelegate(fixture('AppDelegate.sdk54.swift'));
    const twice = ios.modifySwiftAppDelegate(once);
    expect(twice).toBe(once);
    expect(count(twice, 'import LinkFlowSDK')).toBe(1);
    expect(count(twice, 'LinkFlowLinkForwarder.open(')).toBe(1);
  });

  it('forwards links from the Expo SDK 52 Objective-C AppDelegate, idempotently', () => {
    const src = fixture('AppDelegate.sdk52.mm');
    const once = ios.modifyAppDelegate(src, 'objcpp');
    expect(once).toContain(
      'options:(NSDictionary<UIApplicationOpenURLOptionsKey,id> *)options {\n  [(id)NSClassFromString(@"LinkFlowLinkForwarder") performSelector:@selector(openURL:) withObject:url];'
    );
    expect(once).toContain(
      '[(id)NSClassFromString(@"LinkFlowLinkForwarder") performSelector:@selector(continueUserActivity:) withObject:userActivity];'
    );
    expect(ios.modifyAppDelegate(once, 'objcpp')).toBe(once);
  });

  it('fails loudly on an AppDelegate it does not recognise', () => {
    expect(() => ios.modifySwiftAppDelegate('import UIKit\nclass AppDelegate {}\n')).toThrow(
      /forwardNativeLinks: false/
    );
  });
});

describe('Android', () => {
  async function manifestFixture() {
    const file = path.join(__dirname, 'fixtures', 'AndroidManifest.sdk54.xml');
    return AndroidConfig.Manifest.readAndroidManifestAsync(file);
  }

  it('adds an autoVerify App Links filter and a scheme filter once', async () => {
    const manifest = await manifestFixture();
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
    const props = { domains: ['go.example.com', 'links.example.org'], schemes: ['myapp'] };

    const once = android.addIntentFilters(activity, props);
    const twice = android.addIntentFilters(once, props);
    expect(twice).toEqual(once);

    const filters = once['intent-filter'];
    expect(filters).toHaveLength(3); // launcher + App Links + scheme
    const appLinks = filters[1];
    expect(appLinks.$).toEqual({ 'android:autoVerify': 'true' });
    expect(appLinks.action[0].$['android:name']).toBe('android.intent.action.VIEW');
    expect(appLinks.category.map((c) => c.$['android:name'])).toEqual([
      'android.intent.category.DEFAULT',
      'android.intent.category.BROWSABLE',
    ]);
    expect(appLinks.data.map((d) => d.$)).toEqual([
      { 'android:scheme': 'https', 'android:host': 'go.example.com' },
      { 'android:scheme': 'https', 'android:host': 'links.example.org' },
    ]);
    expect(filters[2].$).toEqual({});
    expect(filters[2].data[0].$).toEqual({ 'android:scheme': 'myapp' });
  });

  it('does not duplicate a scheme Expo already added', () => {
    const activity = {
      'intent-filter': [
        {
          action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
          data: [{ $: { 'android:scheme': 'myapp' } }],
        },
      ],
    };
    expect(android.addIntentFilters(activity, { schemes: ['myapp'] })['intent-filter']).toHaveLength(1);
  });

  it('sets and clears the forwarding meta-data', () => {
    const on = android.setForwardingMetaData({ 'meta-data': [] }, true);
    expect(android.setForwardingMetaData(on, true)['meta-data']).toEqual([
      { $: { 'android:name': android.FORWARDING_META, 'android:value': 'true' } },
    ]);
    expect(android.setForwardingMetaData(on, false)['meta-data']).toEqual([]);
  });

  it('adds onNewIntent forwarding to the Expo Kotlin MainActivity, idempotently', () => {
    const src = fixture('MainActivity.sdk54.kt');
    const once = android.modifyMainActivity(src, 'kt');
    expect(once).toContain(
      '  override fun onNewIntent(intent: android.content.Intent) {\n    super.onNewIntent(intent)\n    com.linkflow.sdk.rn.LinkFlowLinkForwarder.onNewIntent(intent)\n  }\n}'
    );
    // Inserted inside the class, before its closing brace.
    expect(once.trimEnd().endsWith('}\n}')).toBe(true);
    expect(android.modifyMainActivity(once, 'kt')).toBe(once);
  });

  it('extends an existing onNewIntent instead of adding a second one', () => {
    const src = [
      'class MainActivity : ReactActivity() {',
      '  override fun onNewIntent(newIntent: Intent?) {',
      '    super.onNewIntent(newIntent)',
      '    doSomething()',
      '  }',
      '}',
      '',
    ].join('\n');
    const out = android.modifyMainActivity(src, 'kt');
    expect(count(out, 'override fun onNewIntent')).toBe(1);
    expect(out).toContain(
      '    super.onNewIntent(newIntent)\n    com.linkflow.sdk.rn.LinkFlowLinkForwarder.onNewIntent(newIntent) // @linkflow/react-native-sdk\n    doSomething()'
    );
  });

  it('supports a Java MainActivity', () => {
    const src = 'public class MainActivity extends ReactActivity {\n  @Override\n  protected String getMainComponentName() { return "main"; }\n}\n';
    const out = android.modifyMainActivity(src, 'java');
    expect(out).toContain('public void onNewIntent(android.content.Intent intent) {');
    expect(out).toContain('com.linkflow.sdk.rn.LinkFlowLinkForwarder.onNewIntent(intent);');
    expect(android.modifyMainActivity(out, 'java')).toBe(out);
  });
});

describe('plugin wiring (registered mods run end to end on the fixtures)', () => {
  const baseConfig = () => ({ name: 'HelloWorld', slug: 'hello-world', scheme: 'myapp' });

  it('modifies AppDelegate, Info.plist, entitlements, manifest and MainActivity', async () => {
    const config = plugin(baseConfig(), { domains: ['go.example.com'] });

    const appDelegate = await runMod(config, 'ios', 'appDelegate', {
      path: '/tmp/project/ios/HelloWorld/AppDelegate.swift',
      language: 'swift',
      contents: fixture('AppDelegate.sdk54.swift'),
    });
    expect(appDelegate.contents).toContain('LinkFlowLinkForwarder.open(url)');

    const entitlements = await runMod(config, 'ios', 'entitlements', {});
    expect(entitlements[ios.ASSOCIATED_DOMAINS]).toEqual(['applinks:go.example.com']);

    const infoPlist = await runMod(config, 'ios', 'infoPlist', {});
    expect(infoPlist.CFBundleURLTypes).toEqual([{ CFBundleURLSchemes: ['myapp'] }]);
    expect(infoPlist.LinkFlowNativeLinkForwarding).toBe(true);

    const manifest = await AndroidConfig.Manifest.readAndroidManifestAsync(
      path.join(__dirname, 'fixtures', 'AndroidManifest.sdk54.xml')
    );
    const androidManifest = await runMod(config, 'android', 'manifest', manifest);
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(androidManifest);
    expect(activity['intent-filter']).toHaveLength(3);
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
    expect(application['meta-data']).toContainEqual({
      $: { 'android:name': android.FORWARDING_META, 'android:value': 'true' },
    });

    const mainActivity = await runMod(config, 'android', 'mainActivity', {
      path: '/tmp/project/android/app/src/main/java/com/helloworld/MainActivity.kt',
      language: 'kt',
      contents: fixture('MainActivity.sdk54.kt'),
    });
    expect(mainActivity.contents).toContain('LinkFlowLinkForwarder.onNewIntent(intent)');
  });

  it('skips code changes when forwardNativeLinks is false', () => {
    const config = plugin(baseConfig(), { domains: ['go.example.com'], forwardNativeLinks: false });
    expect(config.mods.ios.appDelegate).toBeUndefined();
    expect(config.mods.android.mainActivity).toBeUndefined();
  });

  it('runs once even if listed twice', () => {
    const once = plugin(baseConfig(), { domains: ['go.example.com'] });
    const twice = plugin(once, { domains: ['go.example.com'] });
    expect(twice._internal.pluginHistory['@linkflow/react-native-sdk']).toBeDefined();
  });
});
