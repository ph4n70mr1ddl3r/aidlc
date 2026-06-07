/**
 * IT Department Manager — client-side utilities
 */

// Auto-dismiss flash messages after 5 seconds
document.querySelectorAll('.flash').forEach(function (el) {
  setTimeout(function () {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(function () { el.remove(); }, 300);
  }, 5000);
});

// Prevent double-submit on all forms that submit via POST/PUT/DELETE
// (any form with a CSRF token is a mutating form)
document.addEventListener('submit', function (e) {
  var form = e.target;
  if (form.tagName !== 'FORM') return;
  // Disable ALL submit buttons in the form, not just the first one.
  // Some forms have multiple action buttons (e.g. save + status change).
  var btns = form.querySelectorAll('button[type="submit"]');
  if (btns.length) {
    // Use a microtask (Promise.resolve) to disable buttons. This fires after
    // the browser has captured the submit button's name/value for form data
    // (which happens synchronously during the submit event), but before any
    // subsequent submit events from rapid double-clicks can fire.
    // This is faster than the previous setTimeout(10) which left a 10ms window.
    //
    // Skip disabling if an inline onsubmit handler (e.g. confirm() dialog)
    // has already prevented the default action — the user cancelled.
    if (e.defaultPrevented) return;
    Promise.resolve().then(function () {
      btns.forEach(function (btn) {
        btn.disabled = true;
        btn.style.opacity = '0.6';
      });
    });
  }
});

// Close mobile sidebar when clicking outside
document.addEventListener('click', function (e) {
  var sidebar = document.getElementById('sidebar');
  if (sidebar && sidebar.classList.contains('open') && !sidebar.contains(e.target) && !e.target.closest('.mobile-menu-toggle')) {
    sidebar.classList.remove('open');
  }
});
