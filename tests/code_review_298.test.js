const { describe, it, expect } = require('@jest/globals');
const fs = require('fs');
const path = require('path');

// Pass 298 regression suite. Pins the error-page template to the app-wide
// escape-everything convention so a future refactor cannot silently reintroduce
// an unescaped <%= error.message %> interpolation on the error page.
describe('error page — error.message is escaped', () => {
  it('renders error.message through escapeHtml, not bare <%%=', () => {
    const file = path.join(__dirname, '..', 'views', 'pages', 'error.ejs');
    const content = fs.readFileSync(file, 'utf8');
    // The safe pattern: escapeHtml() wraps the message before interpolation.
    expect(content).toContain('<%= escapeHtml(error.message) %>');
    // The unsafe pattern must NOT be present: a bare interpolation would allow
    // HTML injection if a caller ever passes a crafted message.
    expect(content).not.toMatch(/<%= error\.message %>/);
  });
});
