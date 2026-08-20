const tabButtons = document.querySelectorAll('.tab-btn');
tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabButtons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    const target = document.getElementById(btn.dataset.view);
    target.classList.remove('hidden');
    if (btn.dataset.view === 'map-view' && typeof map !== 'undefined') {
      setTimeout(() => map.invalidateSize(), 50);
    }
  });
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.error('Service worker registration failed:', err);
    });
  });
}
