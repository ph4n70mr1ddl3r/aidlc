const { describe, it, expect } = require('@jest/globals');
const fs = require('fs');
const path = require('path');

// Pass 298 regression suite. Pins the error-page template to the app-wide
// escape-everything convention so a future refactor cannot silently reintroduce
// an unescaped error.message interpolation on the error page.
// Pin refreshed in pass 361: EJS escaped-output interpolation (<%=) performs
// the HTML escaping itself, so the manual escapeHtml() wrapper was removed —
// it double-escaped metacharacters and referenced a res.locals helper that is
// undefined for errors thrown before the res.locals middleware ran (the render
// then failed entirely, downgrading the styled page to a bare-text 500). The
// security contract is unchanged: the message is still escaped exactly once,
// and the truly unescaped raw-output form (<%-) stays forbidden. Behavioral
// coverage lives in tests/code_review_361.test.js.
describe('error page — error.message is escaped', () => {
  it('renders error.message through escaped interpolation, not raw output', () => {
    const file = path.join(__dirname, '..', 'views', 'pages', 'error.ejs');
    const content = fs.readFileSync(file, 'utf8');
    // The safe pattern: EJS <%= escapes its expression, so the message is
    // HTML-escaped exactly once without needing a res.locals helper.
    expect(content).toContain('<%= error.message %>');
    // The unsafe pattern must NOT be present: raw-output interpolation (<%-)
    // would allow HTML injection if a caller ever passes a crafted message.
    expect(content).not.toMatch(/<%-\s*error\.message/);
  });
});
