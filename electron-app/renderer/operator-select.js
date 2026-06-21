    const roleClass = r => {
      if (!r) return 'role-other';
      const l = r.toLowerCase();
      if (l === 'admin')    return 'role-admin';
      if (l === 'helpdesk') return 'role-helpdesk';
      if (l === 'viewer')   return 'role-viewer';
      return 'role-other';
    };
    const initials = name => {
      if (!name) return '?';
      const local = name.split('@')[0]; // UPNs: initials from the local part
      return local.split(/[.\s_-]+/).map(s => s[0]).join('').slice(0, 2).toUpperCase() || local.slice(0, 2).toUpperCase();
    };
    // UPNs render as local part + small domain line so long names never clip
    const splitName = name => {
      const at = (name || '').indexOf('@');
      return at === -1 ? { local: name, domain: '' } : { local: name.slice(0, at), domain: name.slice(at) };
    };

    // Exit button — lets the operator quit from the (frameless) launch screen.
    document.getElementById('op-exit').addEventListener('click', () => window.api.appQuit());

    window.api.getOperatorsForLogin().then(data => {
      const list = document.getElementById('operator-list');
      const ops  = data.operators || {};
      const entries = Object.entries(ops);

      if (!entries.length) {
        list.innerHTML = '<div class="no-ops">No operators configured — see Settings.</div>';
        return;
      }

      list.innerHTML = entries.map(([name, role]) => {
        const { local, domain } = splitName(name);
        return `<button class="op-btn" data-name="${name}" data-role="${role || ''}" title="${name}">
          <span class="op-av">${initials(name)}</span>
          <span class="op-meta">
            <span class="op-name">${local}</span>
            ${domain ? `<span class="op-domain">${domain}</span>` : ''}
          </span>
          <span class="op-role ${roleClass(role)}">${role || 'user'}</span>
        </button>`;
      }).join('');

      list.querySelectorAll('.op-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          gateOperator(btn.dataset.name, btn.dataset.role);
        });
      });
    }).catch(() => {
      document.getElementById('operator-list').innerHTML =
        '<div class="no-ops">Could not load operators.</div>';
    });

    document.getElementById('guest-name').textContent = window.api.currentUser;
    document.getElementById('btn-guest').addEventListener('click', () => {
      // Guest = read-only viewer; no PIN required
      window.api.selectOperator(window.api.currentUser, 'guest');
    });

    // ── Entra ID sign-in (device code) ─────────────────────────────────────
    // Interactive directory authentication replaces local-username trust; the
    // signed-in UPN becomes the audited operator identity. Role comes from
    // operators.json (UPN, display name, or UPN local part). The Entra sign-in
    // itself is the auth — no PIN gate on this path.
    const entraBtn    = document.getElementById('btn-entra');
    const entraStatus = document.getElementById('entra-status');
    entraBtn.addEventListener('click', () => {
      entraBtn.disabled = true;
      entraStatus.className = 'entra-status';
      entraStatus.style.display = '';
      entraStatus.textContent = 'Requesting sign-in code…';
      window.api.startEntraOperatorSignin();
    });
    window.api.onEntraDeviceCode(d => {
      entraStatus.innerHTML =
        `Code <b class="entra-code">${d.userCode}</b> is pre-filled in the sign-in window — confirm it and sign in. Waiting…`;
    });
    window.api.onEntraSigninResult(r => {
      if (r.ok) {
        entraStatus.innerHTML = `Signed in as <b>${r.displayName}</b> · role <b>${r.role}</b> — opening console…`;
        window.api.selectOperator(r.name, r.role);
      } else {
        entraStatus.className = 'entra-status err';
        entraStatus.textContent = 'Sign-in failed: ' + (r.error || 'unknown error');
        entraBtn.disabled = false;
      }
    });

    // ── PIN gate for write-access operators ────────────────────────────────
    // admin / helpdesk roles require either a configured PIN (entered now) or
    // a one-time setup if none exists; viewer + guest skip the gate.
    async function gateOperator(name, role) {
      const writeAccess = role === 'admin' || role === 'helpdesk';
      if (!writeAccess) {
        window.api.selectOperator(name, role);
        return;
      }
      const allAuth = await window.api.getOperatorAuth();
      const a = allAuth && allAuth[name];
      // Windows authentication means "trust the current OS session" — exactly as
      // promised when it was set up ("no PIN needed"). Don't re-prompt for the
      // Windows password here; the logged-in session is the proof of identity.
      if (a && a.set && a.mode === 'windows') {
        window.api.selectOperator(name, role);
        return;
      }
      if (!a || !a.set) {
        // No auth configured yet — offer PIN setup or Windows-auth path
        const choice = await showAuthChoice(name);
        if (!choice) return; // cancelled, stay on sign-in
        if (choice === 'windows') {
          await window.api.setOperatorAuthWindows(name);
          window.api.selectOperator(name, role);
          return;
        }
        // PIN path
        const newPin = await showPinPrompt({ title: 'Set a new PIN', body: 'Choose a 4–8 digit PIN. Required for Live writes and approvals.', confirm: true });
        if (!newPin) return;
        const resp = await window.api.setOperatorAuthPin(name, newPin);
        if (!(resp && resp.ok)) return;
        window.api.selectOperator(name, role);
        return;
      }
      // Auth exists — verify
      const pin = await showPinPrompt({ title: a.mode === 'windows' ? 'Confirm Windows session' : 'Enter your PIN', body: 'Required to sign in with write access.', confirm: false });
      if (!pin) return;
      const verify = await window.api.verifyOperatorPin(name, pin);
      if (!(verify && verify.ok)) {
        // Show inline error and retry by re-calling
        showError('PIN incorrect — try again or cancel.');
        return gateOperator(name, role);
      }
      window.api.selectOperator(name, role);
    }

    function showAuthChoice(name) {
      return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'pin-gate-overlay';
        overlay.innerHTML = `
          <div class="pin-gate">
            <h3>Set up authentication</h3>
            <div class="sub">${name} is a write-access operator. Choose how to authenticate this and future sign-ins.</div>
            <div class="pin-gate-choice">
              <button data-c="pin"><span class="label">Use PIN</span><span class="desc">4–8 digit code</span></button>
              <button data-c="windows"><span class="label">Use Windows</span><span class="desc">Trust the OS session</span></button>
            </div>
            <div class="pin-gate-actions"><button class="btn-cancel">Cancel sign-in</button></div>
          </div>`;
        document.body.appendChild(overlay);
        const done = (v) => { overlay.remove(); resolve(v); };
        overlay.querySelectorAll('.pin-gate-choice button').forEach(b => b.addEventListener('click', () => done(b.dataset.c)));
        overlay.querySelector('.btn-cancel').addEventListener('click', () => done(null));
        overlay.addEventListener('click', e => { if (e.target === overlay) done(null); });
      });
    }

    function showPinPrompt({ title, body, confirm }) {
      return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'pin-gate-overlay';
        overlay.innerHTML = `
          <div class="pin-gate">
            <h3>${title}</h3>
            <div class="sub">${body}</div>
            <input type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="off" autofocus maxlength="12" placeholder="PIN" class="pin-input"/>
            ${confirm ? '<input type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="12" placeholder="Confirm PIN" class="pin-confirm"/>' : ''}
            <div class="pin-gate-error"></div>
            <div class="pin-gate-actions">
              <button class="btn-cancel">Cancel</button>
              <button class="btn-ok">OK</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);
        const pinIn = overlay.querySelector('.pin-input');
        const conf  = overlay.querySelector('.pin-confirm');
        const err   = overlay.querySelector('.pin-gate-error');
        const done = (v) => { overlay.remove(); resolve(v); };
        const submit = () => {
          const v = (pinIn.value || '').trim();
          if (v.length < 4) { err.textContent = 'PIN must be at least 4 characters'; return; }
          if (conf && v !== conf.value) { err.textContent = 'PINs do not match'; return; }
          done(v);
        };
        overlay.querySelector('.btn-ok').addEventListener('click', submit);
        overlay.querySelector('.btn-cancel').addEventListener('click', () => done(null));
        pinIn.addEventListener('keydown', e => { if (e.key === 'Enter') (conf ? conf.focus() : submit()); else if (e.key === 'Escape') done(null); });
        if (conf) conf.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); else if (e.key === 'Escape') done(null); });
        setTimeout(() => pinIn.focus(), 50);
      });
    }

    function showError(msg) {
      // Lightweight inline toast
      const t = document.createElement('div');
      t.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);background:var(--surface);border:1px solid oklch(0.45 0.16 24 / .45);color:var(--coral);padding:8px 12px;border-radius:8px;font-size:12px;z-index:200';
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 2500);
    }
