const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const { doubleCsrf } = require('csrf-csrf');

/**
 * Minimal CSRF protection test suite.
 * Exercises the same doubleCsrf setup used in src/app.js to assert:
 *   - requests without a CSRF cookie receive 403
 *   - requests with a CSRF cookie but no body token receive 403
 *   - requests with a CSRF cookie and a mismatched body token receive 403
 *   - requests with a matching cookie + body token succeed (200)
 *   - GET requests are not blocked (CSRF is only checked on write methods)
 */
describe('CSRF token validation', () => {
  let app, server, port;

  beforeEach(() => {
    app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use(
      session({
        secret: 'test-secret-32-chars-long-enough!!!',
        resave: false,
        saveUninitialized: true
      })
    );

    const cfg = doubleCsrf({
      getSecret: () => 'test-secret-32-chars-long-enough!!!',
      getSessionIdentifier: (req) => req.sessionID,
      cookieName: 'csrf-token',
      cookieOptions: { sameSite: 'lax', path: '/', secure: false, httpOnly: true },
      getCsrfTokenFromRequest: (req) => req.body && req.body._csrf,
      size: 64
    });
    app.use(cfg.doubleCsrfProtection);

    app.get('/get-token', (req, res) => {
      res.json({ csrfToken: req.csrfToken() });
    });

    app.post('/write', (req, res) => {
      res.json({ ok: true });
    });

    // Same error-handler pattern as src/app.js
    app.use((err, req, res, _next) => {
      if (err.code === 'EBADCSRFTOKEN') {
        return res.status(403).json({ error: 'Invalid security token' });
      }
      res.status(500).json({ error: err.message });
    });

    server = app.listen(0);
    port = server.address().port;
  });

  afterEach((done) => {
    server.close(done);
  });

  it('GET /get-token sets the csrf-token cookie and returns a token', async () => {
    const res = await fetch(`http://localhost:${port}/get-token`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.csrfToken).toBeDefined();
    expect(body.csrfToken.length).toBeGreaterThan(0);

    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('csrf-token='))).toBe(true);
  });

  it('POST without CSRF cookie returns 403', async () => {
    const res = await fetch(`http://localhost:${port}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Invalid security token');
  });

  it('POST with CSRF cookie but missing body token returns 403', async () => {
    const getTokenRes = await fetch(`http://localhost:${port}/get-token`);
    const cookies = getTokenRes.headers.getSetCookie();
    getTokenRes.json(); // consumes the body to free the response

    // Send the csrf-token cookie but omit _csrf from the body
    const res = await fetch(`http://localhost:${port}/write`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookies.join('; ')
      },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(403);
  });

  it('POST with CSRF cookie and wrong body token returns 403', async () => {
    const getTokenRes = await fetch(`http://localhost:${port}/get-token`);
    const cookies = getTokenRes.headers.getSetCookie();

    const res = await fetch(`http://localhost:${port}/write`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookies.join('; ')
      },
      body: JSON.stringify({ _csrf: 'bad-token' })
    });
    expect(res.status).toBe(403);
  });

  it('POST with matching CSRF cookie + body token returns 200', async () => {
    const getTokenRes = await fetch(`http://localhost:${port}/get-token`);
    const cookies = getTokenRes.headers.getSetCookie();
    const { csrfToken } = await getTokenRes.json();

    const res = await fetch(`http://localhost:${port}/write`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookies.join('; ')
      },
      body: JSON.stringify({ _csrf: csrfToken })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('GET requests are not blocked by CSRF protection', async () => {
    const res = await fetch(`http://localhost:${port}/get-token`);
    expect(res.status).toBe(200);
  });
});
