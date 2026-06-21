    'use strict';
    const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // Populate Windows username
    const winName = window.api.currentUser || '—';
    document.getElementById('win-username').textContent = winName;

    let _accountChoice = 'windows'; // 'windows' | 'skip'

    // Panel navigation
    let _step = 1;
    function goStep(n) {
      for (let i = 1; i <= 3; i++) {
        document.getElementById('panel-' + i).classList.toggle('active', i === n);
        const dot = document.getElementById('dot-' + i);
        dot.classList.remove('active', 'done');
        if (i < n) dot.classList.add('done');
        else if (i === n) dot.classList.add('active');
      }
      _step = n;
    }

    // Step 1
    document.getElementById('btn-start').addEventListener('click', () => goStep(2));
    document.getElementById('btn-skip-all').addEventListener('click', () => {
      window.api.skipFirstRun();
    });

    // Step 2 choices
    document.getElementById('choice-windows').addEventListener('click', () => {
      _accountChoice = 'windows';
      document.getElementById('choice-windows').classList.add('selected');
      document.getElementById('choice-skip-account').classList.remove('selected');
      document.getElementById('win-user-row').style.display = '';
    });
    document.getElementById('choice-skip-account').addEventListener('click', () => {
      _accountChoice = 'skip';
      document.getElementById('choice-skip-account').classList.add('selected');
      document.getElementById('choice-windows').classList.remove('selected');
      document.getElementById('win-user-row').style.display = 'none';
    });

    document.getElementById('btn-back-2').addEventListener('click', () => goStep(1));
    document.getElementById('btn-next-2').addEventListener('click', () => goStep(3));

    // Step 3
    document.getElementById('btn-back-3').addEventListener('click', () => goStep(2));
    document.getElementById('btn-skip-tenant').addEventListener('click', () => {
      finish(false);
    });

    // Step 3 — Entra sign-in fast path. Reuses the operator device-code flow,
    // which signs in against the `organizations` authority when nothing is
    // configured yet, then auto-connects + persists the tenant read from the
    // sign-in token. We mirror that tenant into the manual fields so the
    // operator sees what was detected and "Start JML Fleet" stays consistent.
    const entraBtn     = document.getElementById('choice-entra-signin');
    const entraBtnLbl  = document.getElementById('entra-btn-label');
    const entraBtnDesc = document.getElementById('entra-btn-desc');
    const entraStatus  = document.getElementById('entra-status');
    const entraConnRow = document.getElementById('entra-connected-row');
    const entraAccount = document.getElementById('entra-account');
    let _entraBusy = false;
    let _entraOperator = null;

    entraBtn.addEventListener('click', () => {
      if (_entraBusy) return;
      _entraBusy = true;
      entraBtn.disabled = true;
      entraBtn.classList.remove('connected');
      entraBtnLbl.textContent = 'Waiting for sign-in…';
      entraBtnDesc.textContent = 'A Microsoft sign-in window will open';
      entraStatus.textContent = 'Opening Microsoft sign-in…';
      document.getElementById('err-tenant').textContent = '';
      window.api.startEntraOperatorSignin();
    });

    window.api.onEntraDeviceCode((d) => {
      if (d && d.userCode) {
        entraStatus.innerHTML = 'Finish in the Microsoft window. Code: <b>' + d.userCode + '</b>';
      }
    });

    window.api.onEntraSigninResult(async (r) => {
      _entraBusy = false;
      entraBtn.disabled = false;
      if (!r || !r.ok) {
        entraBtnLbl.textContent = 'Sign in with Microsoft Entra';
        entraBtnDesc.textContent = 'Opens a Microsoft sign-in window — auto-detects your tenant';
        entraStatus.textContent = '';
        document.getElementById('err-tenant').textContent =
          (r && r.error) ? r.error : 'Sign-in failed — try again or enter the Tenant ID manually.';
        return;
      }
      // Resolve the tenant: prefer the id_token `tid` the flow just connected;
      // fall back to the persisted tenant config if it was already set.
      let tid = r.tenantConnected || '';
      if (!tid) {
        try { const t = await window.api.getTenantConfig(); tid = (t && t.tenantId) || ''; } catch (_) {}
      }
      _entraOperator = {
        name: r.name || '',
        displayName: r.displayName || r.name || '',
        role: r.role || 'viewer'
      };
      const domain = (r.name && r.name.includes('@')) ? r.name.split('@')[1] : '';
      if (tid && GUID_RE.test(tid)) document.getElementById('setup-tenant-id').value = tid;
      if (domain) document.getElementById('setup-primary-domain').value = domain;

      entraAccount.textContent = r.displayName || r.name || 'Signed in';
      entraConnRow.style.display = '';
      entraStatus.textContent = '';
      entraBtn.classList.add('connected');
      entraBtnLbl.textContent = tid ? 'Signed in — tenant connected' : 'Signed in';
      entraBtnDesc.textContent = tid ? ('Tenant ' + tid.slice(0, 8) + '…') : 'Tenant not detected — enter it below';
    });

    document.getElementById('btn-done').addEventListener('click', () => {
      const tenantId = document.getElementById('setup-tenant-id').value.trim();
      const err = document.getElementById('err-tenant');
      if (tenantId && !GUID_RE.test(tenantId)) {
        err.textContent = 'Tenant ID must be a GUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)';
        return;
      }
      err.textContent = '';
      finish(true);
    });

    async function finish(withTenant) {
      const tenantId     = withTenant ? document.getElementById('setup-tenant-id').value.trim() : '';
      const primaryDomain= withTenant ? document.getElementById('setup-primary-domain').value.trim() : '';
      await window.api.completeFirstRun({
        winAuth:       _accountChoice === 'windows',
        tenantId:      tenantId      || null,
        primaryDomain: primaryDomain || null,
        entraOperator: _entraOperator
      });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') window.api.skipFirstRun();
    });
