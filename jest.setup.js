// Silence console.warn / console.error during tests to keep output clean.
// The application deliberately emits these warnings (e.g. invalid PAGE_SIZE,
// missing SESSION_SECRET in dev, buildFilters skipping invalid columns), so
// the tests should not be forced to assert on or swallow each one individually.
const noop = () => {};
beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(noop);
  jest.spyOn(console, 'error').mockImplementation(noop);
});
afterAll(() => {
  console.warn.mockRestore();
  console.error.mockRestore();
});

// Pin the number formatting locale so template assertions on formatted output
// ('$5,000', '$1,200') are deterministic regardless of the host environment's
// locale (a de-DE host would render '5.000' and break those tests). The app
// uses Number(x).toLocaleString() in templates, which in V8 delegates to
// Intl.NumberFormat(locales, ...).format(x) with locales undefined — forcing
// any locale-less construction to the shared en-US formatter pins the output.
const enUsNumberFormat = new Intl.NumberFormat('en-US');
const NativeNumberFormat = Intl.NumberFormat;
Intl.NumberFormat = function (...args) {
  const [locales] = args;
  const locale = Array.isArray(locales) ? locales[0] : locales;
  return (locale === undefined || locale === 'en-US') ? enUsNumberFormat : new NativeNumberFormat(...args);
};
Intl.NumberFormat.prototype = NativeNumberFormat.prototype;
