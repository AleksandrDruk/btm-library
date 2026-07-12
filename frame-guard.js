(() => {
  const root = document.documentElement;
  if (globalThis.top === globalThis.self) {
    root.classList.remove('btm-frame-blocked');
    return;
  }

  root.setAttribute('aria-hidden', 'true');
  root.inert = true;
})();
