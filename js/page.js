// Static pages (blog index, posts): theme toggle only. The home page uses app.js instead.
(function () {
  var btn = document.getElementById('theme');
  var root = document.documentElement;
  function sync() { if (btn) btn.setAttribute('aria-pressed', root.getAttribute('data-theme') === 'night'); }
  sync();
  if (btn) btn.addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'night' ? 'day' : 'night';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) {}
    sync();
  });
  document.querySelectorAll('[data-top]').forEach(function (a) {
    a.addEventListener('click', function (e) { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  });
})();
