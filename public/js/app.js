/**
 * IT Department Manager — client-side utilities
 */

// Auto-dismiss flash messages after 5 seconds
document.querySelectorAll('.flash').forEach(function (el) {
  el.style.transition = 'opacity 0.3s';
  setTimeout(function () {
    el.style.opacity = '0';
    setTimeout(function () {
      el.remove();
    }, 300);
  }, 5000);
});

// Prevent double-submit on all forms that submit via POST/PUT/DELETE
// (any form with a CSRF token is a mutating form)
document.addEventListener('submit', function (e) {
  const form = e.target;
  if (form.tagName !== 'FORM') {
    return;
  }
  // Skip disabling if an onsubmit handler (e.g. confirm() dialog)
  // has already prevented the default action — the user cancelled.
  if (e.defaultPrevented) {
    return;
  }
  // Disable ALL submit buttons in the form, not just the first one.
  // Some forms have multiple action buttons (e.g. save + status change).
  const btns = form.querySelectorAll('button[type="submit"]');
  if (btns.length) {
    btns.forEach(function (btn) {
      btn.disabled = true;
      btn.style.opacity = '0.6';
    });
  }
  // Track whether any form was submitted in this page session.
  // Used to avoid re-enabling buttons on unrelated visibility changes.
  form.dataset.submitted = 'true';
  // Re-enable buttons if the page stays on the same form (e.g. network
  // error, validation redirect, or bfcache restore).
  function _reenableButtons() {
    const submittedForms = document.querySelectorAll('form[data-submitted="true"]');
    if (!submittedForms.length) {
      return;
    }
    submittedForms.forEach(function (f) {
      f.querySelectorAll('button[type="submit"][disabled]').forEach(function (btn) {
        btn.disabled = false;
        btn.style.opacity = '';
      });
      delete f.dataset.submitted;
    });
  }
  if (!window._formReenableAttached) {
    window._formReenableAttached = true;
    // Catch JS runtime errors and unhandled rejections
    window.addEventListener('error', _reenableButtons);
    window.addEventListener('unhandledrejection', _reenableButtons);
    // Catch bfcache restore (e.g. back button after failed submit)
    window.addEventListener('pageshow', _reenableButtons);
    // Catch network failures that don't fire JS errors — only re-enable
    // if a form was actually submitted on this page, so we don't interfere
    // with legitimately disabled buttons on tab refocus.
    window.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        _reenableButtons();
      }
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
    if (sidebar) {
      sidebar.classList.toggle('open');
    }
  }
});

// Confirmation dialogs: <form data-confirm="message">
document.addEventListener('submit', function (e) {
  const form = e.target;
  if (form.tagName !== 'FORM') {
    return;
  }
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
  if (!btn) {
    return;
  }
  const licenseId = btn.getAttribute('data-license-reveal');
  const display = document.getElementById('license-key-display');
  if (!display) {
    return;
  }
  if (display.dataset.shown === '1') {
    const storedKey = _licenseKeys[licenseId] || '';
    display.textContent = storedKey ? '****' + storedKey.slice(-4) : '****';
    display.dataset.shown = '';
    btn.querySelector('i').className = 'fas fa-eye';
  } else {
    // Fetch key via AJAX on first reveal
    // Use POST with CSRF token (GET is not CSRF-protected)
    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    const csrfToken = csrfMeta ? csrfMeta.getAttribute('content') : '';
    fetch('/licenses/' + licenseId + '/key', {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': csrfToken
      }
    })
      .then(function (res) {
        if (!res.ok) {
          throw new Error('HTTP ' + res.status);
        }
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
