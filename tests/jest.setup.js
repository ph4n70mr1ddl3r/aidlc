// Global mock for sanitize-html. sanitize-html@2.17.7 depends on htmlparser2@12
// which is ESM-only; Jest's CJS runtime cannot load it. This mock provides a
// CJS-compatible shim that mirrors the real API surface used by knowledge.js.
// Placing it here (as a setupFile, not setupFilesAfterEnv) ensures it runs
// before every test file's requires, so all tests get the same behavior.
/* global jest */
jest.mock('sanitize-html', () => {
  const mockSanitize = (html, opts) => {
    if (typeof html !== 'string') {
      throw new TypeError('Expected a string');
    }
    let result = html;
    result = result.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    result = result.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
    const allowedTags = opts && Array.isArray(opts.allowedTags) ? opts.allowedTags : [];
    if (allowedTags.length === 0) {
      return result.replace(/<[^>]+>/g, '');
    }
    result = result.replace(/on\w+\s*=\s*["'][^"']*["']/gi, '');
    result = result.replace(/<input\b[^>]*\/?>/gi, '');
    result = result.replace(/href\s*=\s*"javascript:[^"]*"/gi, 'href="#"');
    result = result.replace(/href\s*=\s*'javascript:[^']*'/gi, "href='#'");
    result = result.replace(/href\s*=\s*javascript:[^<)>]*/gi, 'href="#"');
    result = result.replace(/<a\s([^>]*)>/gi, (match, attrs) => {
      return `<a ${attrs}${attrs.includes('rel=') ? '' : ' rel="noopener noreferrer"'}>`;
    });
    return result;
  };
  mockSanitize.defaults = {
    allowedTags: ['h1','h2','h3','h4','h5','h6','blockquote','p','a','ul','ol','li','b','i','strong','em','strike','code','hr','br','div','table','thead','caption','tbody','tr','th','td','pre','img','span','details','summary','del'],
    allowedAttributes: {
      a: ['href','name','target','rel','title'],
      img: ['src','alt','title'],
      code: ['class']
    }
  };
  mockSanitize.simpleTransform = () => (tagName, attribs) => {
    if (tagName === 'a') {
      attribs.rel = 'noopener noreferrer';
    }
    return attribs;
  };
  return mockSanitize;
});
