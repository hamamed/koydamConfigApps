// Sign-in. Deliberately small: it holds no secrets and runs before there is a
// session to protect.

const form = document.getElementById('loginForm');
const errorBox = document.getElementById('loginError');
const submit = document.getElementById('submit');

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove('d-none');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.classList.add('d-none');
  submit.disabled = true;

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Same-origin, but stated so a future move to a separate host does not
      // silently drop the session cookie.
      credentials: 'same-origin',
      body: JSON.stringify({
        email: document.getElementById('email').value.trim(),
        password: document.getElementById('password').value,
        // Where another panel bounced us from. The server validates it against
        // an allowlist before echoing it back.
        next: new URLSearchParams(location.search).get('next'),
      }),
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      showError(body.message ?? 'Sign-in failed.');
      submit.disabled = false;
      return;
    }

    // Replace rather than assign: the login page should not sit in history
    // behind the dashboard, where Back would land on a form that now redirects.
    location.replace(body.next || '/');
  } catch {
    showError('Could not reach the server.');
    submit.disabled = false;
  }
});
