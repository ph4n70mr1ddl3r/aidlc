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
  const form = e.target;
  if (form.tagName !== 'FORM') { return; }
  // Skip disabling if an onsubmit handler (e.g. confirm() dialog)
  // has already prevented the default action — the user cancelled.
  if (e.defaultPrevented) { return; }
  // Disable ALL submit buttons in the form, not just the first one.
  // Some forms have multiple action buttons (e.g. save + status change).
  const btns = form.querySelectorAll('button[type="submit"]');
  if (btns.length) {
    btns.forEach(function (btn) {
      btn.disabled = true;
      btn.style.opacity = '0.6';
    });
    // Re-enable buttons on fetch/network errors so the user can retry
    Promise.resolve().then(function () {
      var firstBtn = btns[0];
      if (!firstBtn) return;
      var formEl = firstBtn.form || form;
      formEl.addEventListener('reset', function () {
        btns.forEach(function (btn) {
          btn.disabled = false;
          btn.style.opacity = '';
        });
      });
    });
  }
  // Also re-enable buttons if the page stays on the same form (e.g. network
  // error or validation redirect). Track the pending re-enable via a module-
  // level flag so only one global error listener is ever registered.
  if (!window._formReenableAttached) {
    window._formReenableAttached = true;
    window.addEventListener('error', function () {
      document.querySelectorAll('button[type="submit"][disabled]').forEach(function (btn) {
        btn.disabled = false;
        btn.style.opacity = '';
      });
    });
  }
});

// Close mobile sidebar when clicking outside
document.addEventListener('click', function (e) {
  const sidebar = document.getElementById('sidebar');
  if (sidebar && sidebar.classList.contains('open') && !sidebar.contains(e.target) && !e.target.closest('.mobile-menu-toggle')) {
    sidebar.classList.remove('open');
  }
});

// --- Data-attribute driven event handlers (CSP-safe, no inline onclick/onsubmit) ---

// Mobile menu toggle: <button data-toggle="sidebar">
document.addEventListener('click', function (e) {
  const toggle = e.target.closest('[data-toggle="sidebar"]');
  if (toggle) {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) { sidebar.classList.toggle('open'); }
  }
});

// Confirmation dialogs: <form data-confirm="message">
document.addEventListener('submit', function (e) {
  const form = e.target;
  if (form.tagName !== 'FORM') { return; }
  const msg = form.getAttribute('data-confirm');
  if (msg && !confirm(msg)) {
    e.preventDefault();
  }
});

// Auto-submit on select change: <select data-auto-submit>
document.addEventListener('change', function (e) {
  if (e.target.matches('[data-auto-submit]')) {
    e.target.form.submit();
  }
});

// License key reveal: <button data-license-reveal="id"> toggles key display
// The full key is NEVER embedded in the initial HTML — it is fetched via
// AJAX on first reveal and stored in a closure variable only (not in the DOM).
// Toggling back shows the masked preview (last 4 chars) without re-fetching.
const _licenseKeys = {};
document.addEventListener('click', function (e) {
  const btn = e.target.closest('[data-license-reveal]');
  if (!btn) { return; }
  const licenseId = btn.getAttribute('data-license-reveal');
  const display = document.getElementById('license-key-display');
  if (!display) { return; }
  if (display.dataset.shown === '1') {
    const storedKey = _licenseKeys[licenseId] || '';
    display.textContent = storedKey ? '****' + storedKey.slice(-4) : '****';
    display.dataset.shown = '';
    btn.querySelector('i').className = 'fas fa-eye';
  } else {
    // Fetch key via AJAX on first reveal
    fetch('/licenses/' + licenseId + '/key', {
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    })
      .then(function (res) {
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.json();
      })
      .then(function (data) {
        _licenseKeys[licenseId] = data.key;
        display.textContent = data.key;
        display.dataset.shown = '1';
        btn.querySelector('i').className = 'fas fa-eye-slash';
      })
      .catch(function () {
        display.textContent = 'Error loading key';
      });
  }
});
