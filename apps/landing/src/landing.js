// Small progressive enhancements. The page works without any of this.
(function () {
  var root = document.documentElement;
  var stored = null;
  try { stored = localStorage.getItem('vg.site.theme'); } catch (e) { /* storage blocked */ }
  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  root.setAttribute('data-theme', stored || (prefersDark ? 'dark' : 'light'));

  document.getElementById('theme-btn').addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('vg.site.theme', next); } catch (e) { /* ignore */ }
  });

  var nav = document.getElementById('nav'), mb = document.getElementById('menu-btn');
  mb.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    mb.setAttribute('aria-expanded', String(open));
  });
  nav.addEventListener('click', function (e) { if (e.target.tagName === 'A') { nav.classList.remove('open'); mb.setAttribute('aria-expanded', 'false'); } });

  document.getElementById('year').textContent = String(new Date().getFullYear());

  // scroll progress + back to top
  var bar = document.getElementById('bar'), up = document.getElementById('up');
  function onScroll() {
    var h = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = (h > 0 ? Math.min(100, (window.scrollY / h) * 100) : 0) + '%';
    up.classList.toggle('show', window.scrollY > 600);
  }
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
  up.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });

  // invite links (vanishgram.karatel.win/#join=... or #channel=...) hand over to the desktop app
  var hash = location.hash;
  if (/^#(join|channel)=/.test(hash)) {
    document.getElementById('invite-link').setAttribute('href', 'vanishgram://open' + hash);
    document.getElementById('invite').classList.add('show');
  }

  // highlight the download that matches this computer
  var ua = navigator.userAgent || '';
  var os = /Windows/.test(ua) ? 'win' : /Mac/.test(ua) ? 'mac' : /Linux|X11/.test(ua) ? 'linux' : '';
  if (os) { var card = document.querySelector('[data-os="' + os + '"]'); if (card) card.classList.add('me'); }

  // copy checksum buttons
  document.querySelectorAll('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      var text = b.getAttribute('data-copy');
      var done = function () { var old = b.textContent; b.textContent = 'Copied'; setTimeout(function () { b.textContent = old; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {}); else done();
    });
  });
})();
