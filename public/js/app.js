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

// Close mobile sidebar when clicking outside
document.addEventListener('click', function (e) {
  var sidebar = document.getElementById('sidebar');
  if (sidebar && sidebar.classList.contains('open') && !sidebar.contains(e.target) && !e.target.closest('.mobile-menu-toggle')) {
    sidebar.classList.remove('open');
  }
});
