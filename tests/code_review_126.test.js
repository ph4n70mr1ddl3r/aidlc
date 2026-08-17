const { describe, it, expect } = require('@jest/globals');
const fs = require('fs');
const path = require('path');

// Regression tests for session password exclusion on in-request refresh paths.
// The login handler explicitly destructures `password` out of the user row
// before storing it in the session. The in-request session refreshes
// (profile update, staff self-edit, password-change) also assign a fresh DB
// row back into req.session.user. Even though the current SELECT statements
// omit the password column, the destructuring guard is kept as defense-in-depth
// so a future refactor that adds `password` back to a SELECT cannot silently
// re-introduce credential leakage into the session. These tests pin the
// contract by verifying the destructuring pattern is present in the source.

function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

describe('session password exclusion on in-request refresh (source-level regression)', () => {
  it('auth.js profile update destructures password out of the fresh DB row before assigning to session', () => {
    const src = readSource('src/routes/auth.js');
    // The profile update route fetches fresh user data and must not include password.
    expect(src).toMatch(/const\s*\{\s*password:\s*_\w+,\s*\.\.\.\s*sessionUser\s*\}\s*=\s*freshUser/);
  });

  it('auth.js password-change route destructures password out of the fresh DB row before assigning to session', () => {
    const src = readSource('src/routes/auth.js');
    // The password-change route also refreshes the session and must strip password.
    expect(src).toMatch(/const\s*\{\s*password:\s*_\w+,\s*\.\.\.\s*sessionUser\s*\}\s*=\s*freshUser/);
    // There should be at least two occurrences (profile update + password change).
    const matches = src.match(/const\s*\{\s*password:\s*_\w+,\s*\.\.\.\s*sessionUser\s*\}/g);
    expect(matches).toBeTruthy();
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('staff.js self-update route destructures password out of the fresh DB row before assigning to session', () => {
    const src = readSource('src/routes/staff.js');
    // The staff self-edit route refreshes the session and must strip password.
    expect(src).toMatch(/const\s*\{\s*password:\s*_\w+,\s*\.\.\.\s*sessionUser\s*\}\s*=\s*fresh/);
  });

  it('login handler already destructures password out of the user row (original guard)', () => {
    const src = readSource('src/routes/auth.js');
    // The login handler was the original place where this pattern was established.
    expect(src).toMatch(/const\s*\{\s*password:\s*_\w+,\s*\.\.\.\s*sessionUser\s*\}\s*=\s*user/);
  });
});
