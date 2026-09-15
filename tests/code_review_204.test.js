const { describe, it, expect } = require('@jest/globals');
const fs = require('fs');
const path = require('path');

describe('code review 204 — logError consistency in knowledge.js', () => {
  it('knowledge.js imports logError from utils', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'routes', 'knowledge.js'),
      'utf8'
    );
    expect(src).toContain("logError } = require('../utils')");
  });

  it('knowledge.js uses logError for HTML sanitization error logging', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'routes', 'knowledge.js'),
      'utf8'
    );
    // Both sanitization error sites should use logError, not raw console.error
    const lines = src.split('\n');
    for (const line of lines) {
      if (line.includes('HTML sanitization error')) {
        expect(line).toMatch(/logError/);
      }
    }
  });

  it('no raw console.error with err-like last arg in knowledge.js', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'routes', 'knowledge.js'),
      'utf8'
    );
    const lines = src.split('\n');
    for (const line of lines) {
      if (line.includes('console.error') && line.includes('sanitized')) {
        expect(line).not.toMatch(/console\.error\([^)]*sanitized\.error\)/);
      }
    }
  });
});
