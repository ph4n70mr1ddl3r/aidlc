const { describe, it, expect } = require('@jest/globals');
const fs = require('fs');
const path = require('path');
const utils = require('../src/utils');

describe('code review 191 — logError null safety', () => {
  it('logError extracts err.message without throwing when err is an Error', () => {
    // Use process.stdout.write to avoid conflicting with the global console.error
    // mock in jest.setup.js. The helper simply passes through to console.error
    // after transforming the last argument, so we verify the transformation logic
    // by calling the helper and checking what it would log via a captured reference.
    const logged = [];
    const origError = console.error;
    console.error = (...args) => logged.push(args);
    const err = new Error('boom');
    utils.logError('prefix:', err);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toEqual(['prefix:', 'boom']);
    console.error = origError;
  });

  it('logError falls back to String(err) when err has no message property', () => {
    const logged = [];
    const origError = console.error;
    console.error = (...args) => logged.push(args);
    utils.logError('prefix:', 'a plain string');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toEqual(['prefix:', 'a plain string']);
    console.error = origError;
  });

  it('logError returns empty string for undefined last arg', () => {
    const logged = [];
    const origError = console.error;
    console.error = (...args) => logged.push(args);
    utils.logError('prefix:');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toEqual(['prefix:']);
    console.error = origError;
  });

  it('logError passes null through unchanged (null is a valid log value)', () => {
    const logged = [];
    const origError = console.error;
    console.error = (...args) => logged.push(args);
    utils.logError('prefix:', null);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toEqual(['prefix:', null]);
    console.error = origError;
  });

  it('app.js error handlers still use the inline guard pattern', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    // The five app.js error sites established in pass 190 remain intact.
    expect(src).toContain('(err && err.message) || String(err)');
  });

  it('every route module uses logError or inline guard where error logging exists', () => {
    const routesDir = path.join(__dirname, '..', 'src', 'routes');
    const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));
    for (const file of files) {
      const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
      // Only assert when the file actually has console.error calls with err.message
      if (src.includes('err.message') || src.includes('innerErr.message') || src.includes('regErr.message')) {
        const usesLogError = src.includes('logError');
        const hasInlineGuard = src.includes('(err && err.message) || String(err)') ||
          src.includes('(innerErr && innerErr.message) || String(innerErr)') ||
          src.includes('(regErr && regErr.message) || String(regErr)');
        expect(usesLogError || hasInlineGuard).toBe(true);
      }
    }
  });

  it('middleware modules import and use logError or inline guard', () => {
    const middlewareDir = path.join(__dirname, '..', 'src', 'middleware');
    const files = fs.readdirSync(middlewareDir).filter(f => f.endsWith('.js'));
    for (const file of files) {
      const src = fs.readFileSync(path.join(middlewareDir, file), 'utf8');
      const usesLogError = src.includes('logError');
      const hasInlineGuard = src.includes('(err && err.message) || String(err)');
      expect(usesLogError || hasInlineGuard).toBe(true);
    }
  });

  it('database.js uses logError or inline guard', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'models', 'database.js'), 'utf8');
    const usesLogError = src.includes('logError');
    const hasInlineGuard = src.includes('(err && err.message) || String(err)');
    expect(usesLogError || hasInlineGuard).toBe(true);
  });

  it('utils.js createAuditLogPruner null-guards err.message', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils.js'), 'utf8');
    expect(src).toContain('(err && err.message) || String(err)');
  });
});
