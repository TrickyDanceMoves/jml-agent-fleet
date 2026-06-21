// Pre-paint theme bootstrap for the OOBE surfaces (externalized so the page CSP can drop 'unsafe-inline').
    // Apply the persisted theme before first paint so the OOBE brand mark
    // never flashes the default treatment.
    try {
      const t = localStorage.getItem('jmlTheme');
      if (t === 'glass' || t === 'preview') document.documentElement.dataset.theme = t;
    } catch (_) {}
