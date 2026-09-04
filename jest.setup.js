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
// Formatting options (second arg, e.g. { style: 'currency' }) are forwarded so
// a future options-bearing call does not silently lose them.
const NativeNumberFormat = Intl.NumberFormat;
Intl.NumberFormat = function (...args) {
  const [locales, options] = args;
  const locale = Array.isArray(locales) ? locales[0] : locales;
  if (locale === undefined || locale === 'en-US') {
    return new NativeNumberFormat('en-US', options);
  }
  return new NativeNumberFormat(...args);
};
Intl.NumberFormat.prototype = NativeNumberFormat.prototype;

// Pin date formatting the same way: templates render dates via
// toLocaleDateString/toLocaleString (Intl.DateTimeFormat with undefined locale),
// so a non-en-US host would break date assertions. Force locale-less
// constructions to en-US for determinism, forwarding options.
const NativeDateTimeFormat = Intl.DateTimeFormat;
Intl.DateTimeFormat = function (...args) {
  const [locales, options] = args;
  const locale = Array.isArray(locales) ? locales[0] : locales;
  if (locale === undefined || locale === 'en-US') {
    return new NativeDateTimeFormat('en-US', options);
  }
  return new NativeDateTimeFormat(...args);
};
Intl.DateTimeFormat.prototype = NativeDateTimeFormat.prototype;
