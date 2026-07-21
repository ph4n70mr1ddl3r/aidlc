/**
 * Shared test utilities — extracted from auth-login.test.js and hpp.test.js
 * to avoid duplication across the test suite.
 */

/**
 * Capture the last handler (after middleware) for a given route on an Express
 * router. Useful for unit-testing individual route handlers in isolation.
 * @param {import('express').Router} router
 * @param {string} method  — HTTP method ('get','post','put','delete','patch')
 * @param {string} pathPattern — exact route path (e.g. '/:id')
 * @returns {Function} the handler function
 */
function lastHandlerFor(router, method, pathPattern) {
  const layer = router.stack.find((l) => {
    const m = l.route && l.route.methods[method];
    return m && l.route.path === pathPattern;
  });
  if (!layer || !layer.route || !layer.route.stack) {
    throw new Error(`Route ${method.toUpperCase()} ${pathPattern} not found on router`);
  }
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

module.exports = { lastHandlerFor };
