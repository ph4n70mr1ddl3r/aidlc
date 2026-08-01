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
