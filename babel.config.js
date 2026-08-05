/**
 * Babel config for the test run.
 *
 * The package declared `jest` with the `react-native` preset but shipped no
 * Babel config, so Jest could not transform TypeScript/JSX at all — `npm test`
 * only ever "passed" because there were no test files. Consumers of the library
 * use their own app's Babel config; this exists for the SDK's own tests and for
 * `react-native-builder-bob`.
 */
module.exports = {
  presets: ['module:@react-native/babel-preset'],
};
