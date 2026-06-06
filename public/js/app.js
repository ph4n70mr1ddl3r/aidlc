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
    // Disable after a tiny delay so the form still submits
    setTimeout(function () {
      btns.forEach(function (btn) {
        btn.disabled = true;
        btn.style.opacity = '0.6';
      });
    }, 10);
  }
});

// Close mobile sidebar when clicking outside
document.addEventListener('click', function (e) {
  var sidebar = document.getElementById('sidebar');
  if (sidebar && sidebar.classList.contains('open') && !sidebar.contains(e.target) && !e.target.closest('.mobile-menu-toggle')) {
    sidebar.classList.remove('open');
  }
});
