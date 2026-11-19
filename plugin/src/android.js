'use strict';

/**
 * Android modifications for the LinkFlow Expo config plugin. Pure and
 * idempotent; the `with*` wiring lives in ./index.js.
 */

const MARKER = '@linkflow/react-native-sdk';
/** Read by the native module; tells JS not to forward links a second time. */
const FORWARDING_META = 'com.linkflow.sdk.NATIVE_LINK_FORWARDING';

const VIEW = 'android.intent.action.VIEW';
const DEFAULT = 'android.intent.category.DEFAULT';
const BROWSABLE = 'android.intent.category.BROWSABLE';

function names(list) {
  return (list || []).map((x) => x && x.$ && x.$['android:name']);
}

function dataEntries(filter) {
  return (filter.data || []).map((d) => (d && d.$) || {});
}

function isViewFilter(filter) {
  return names(filter.action).includes(VIEW);
}

function hasHttpsHost(filters, host) {
  return filters.some(
    (f) =>
      isViewFilter(f) &&
      dataEntries(f).some((d) => d['android:scheme'] === 'https' && d['android:host'] === host)
  );
}

function hasScheme(filters, scheme) {
  return filters.some(
    (f) => isViewFilter(f) && dataEntries(f).some((d) => d['android:scheme'] === scheme && !d['android:host'])
  );
}

function viewFilter(attrs, data) {
  return {
    $: attrs,
    action: [{ $: { 'android:name': VIEW } }],
    category: [{ $: { 'android:name': DEFAULT } }, { $: { 'android:name': BROWSABLE } }],
    data,
  };
}

/**
 * Adds to the main activity:
 * - one `autoVerify` App Links filter covering every domain not yet handled;
 * - a filter per custom scheme not yet handled (Expo adds the app.json
 *   `scheme` itself, so it is usually skipped).
 */
function addIntentFilters(activity, { domains = [], schemes = [], autoVerify = true }) {
  const filters = Array.isArray(activity['intent-filter']) ? [...activity['intent-filter']] : [];

  const newHosts = domains.filter((h) => !hasHttpsHost(filters, h));
  if (newHosts.length > 0) {
    filters.push(
      viewFilter(
        autoVerify ? { 'android:autoVerify': 'true' } : {},
        newHosts.map((host) => ({ $: { 'android:scheme': 'https', 'android:host': host } }))
      )
    );
  }
  for (const scheme of schemes) {
    if (!hasScheme(filters, scheme)) {
      filters.push(viewFilter({}, [{ $: { 'android:scheme': scheme } }]));
    }
  }
  return { ...activity, 'intent-filter': filters };
}

/** Sets or removes the forwarding meta-data on <application>. */
function setForwardingMetaData(application, enabled) {
  const meta = (application['meta-data'] || []).filter(
    (m) => !(m && m.$ && m.$['android:name'] === FORWARDING_META)
  );
  if (enabled) {
    meta.push({ $: { 'android:name': FORWARDING_META, 'android:value': 'true' } });
  }
  return { ...application, 'meta-data': meta };
}

function notFound(what) {
  return new Error(
    `[${MARKER}] Could not find ${what} in MainActivity. Add the LinkFlow forwarding call by hand ` +
      '(see the README section "Bare React Native") and set `forwardNativeLinks: false` in the plugin options.'
  );
}

/** Index of the brace closing the block that opens at `open`. Ignores braces in strings and comments. */
function matchingBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const q = c;
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2);
      if (i < 0) return -1;
      i++;
      continue;
    }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

const CALL = 'com.linkflow.sdk.rn.LinkFlowLinkForwarder.onNewIntent';

/**
 * Forwards `onNewIntent` to the SDK. Adds the override when MainActivity has
 * none; otherwise inserts the call after `super.onNewIntent(...)`.
 */
function modifyMainActivity(src, language) {
  if (src.includes(CALL)) return src;
  const kotlin = language === 'kt';
  if (!kotlin && language !== 'java') {
    throw new Error(`[${MARKER}] Unsupported MainActivity language: ${language}`);
  }
  const semi = kotlin ? '' : ';';

  const existing = kotlin
    ? /override\s+fun\s+onNewIntent\s*\(\s*(\w+)\s*:\s*[\w.]*Intent\??\s*\)[^{]*\{/.exec(src)
    : /public\s+void\s+onNewIntent\s*\(\s*(?:final\s+)?[\w.]*Intent\s+(\w+)\s*\)[^{]*\{/.exec(src);

  if (existing) {
    const param = existing[1];
    const bodyStart = existing.index + existing[0].length;
    const bodyEnd = matchingBrace(src, bodyStart - 1);
    const body = src.slice(bodyStart, bodyEnd);
    const superCall = new RegExp(`super\\.onNewIntent\\(\\s*${param}\\s*\\)[ \\t]*;?[^\\n]*\\n`).exec(body);
    const line = `    ${CALL}(${param})${semi} // ${MARKER}\n`;
    if (superCall) {
      const at = bodyStart + superCall.index + superCall[0].length;
      return src.slice(0, at) + line + src.slice(at);
    }
    return src.slice(0, bodyStart) + '\n' + line.replace(/\n$/, '') + src.slice(bodyStart);
  }

  const cls = /class\s+MainActivity\b[^{]*\{/.exec(src);
  if (!cls) throw notFound('class MainActivity');
  const close = matchingBrace(src, cls.index + cls[0].length - 1);
  if (close < 0) throw notFound('the end of class MainActivity');

  const method = kotlin
    ? [
        '',
        `  // ${MARKER}: forward links opened while the app is running to LinkFlow.`,
        '  override fun onNewIntent(intent: android.content.Intent) {',
        '    super.onNewIntent(intent)',
        `    ${CALL}(intent)`,
        '  }',
        '',
      ]
    : [
        '',
        `  // ${MARKER}: forward links opened while the app is running to LinkFlow.`,
        '  @Override',
        '  public void onNewIntent(android.content.Intent intent) {',
        '    super.onNewIntent(intent);',
        `    ${CALL}(intent);`,
        '  }',
        '',
      ];
  return src.slice(0, close).replace(/\s*$/, '\n') + method.join('\n') + src.slice(close);
}

module.exports = {
  FORWARDING_META,
  addIntentFilters,
  setForwardingMetaData,
  modifyMainActivity,
};
