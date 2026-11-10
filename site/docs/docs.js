(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x) e.textContent = x; return e; };
  const live = $('#live');
  const say = m => { if (live) { live.textContent = m; setTimeout(() => { live.textContent = ''; }, 1500); } };

  // theme toggle (pre-paint script in <head> sets data-theme)
  const tb = $('#theme'), root = document.documentElement, mq = matchMedia('(prefers-color-scheme: dark)');
  const cur = () => root.dataset.theme || (mq.matches ? 'dark' : 'light');
  const sync = () => { const d = cur() === 'dark'; tb.setAttribute('aria-label', d ? 'Switch to light mode' : 'Switch to dark mode'); $('.i-sun', tb).hidden = !d; $('.i-moon', tb).hidden = d; };
  tb.addEventListener('click', () => { const n = cur() === 'dark' ? 'light' : 'dark'; root.setAttribute('data-theme', n); try { localStorage.setItem('theme', n); } catch (e) {} sync(); });
  mq.addEventListener('change', sync); sync();

  // GitHub star count (same cache key as the homepage)
  (() => {
    const K = 'gh-stars', u = 'https://api.github.com/repos/dennisonbertram/cloudycloud';
    const show = n => {
      if (!Number.isFinite(n) || n < 0) return;
      const t = n >= 1000 ? (Math.floor(n / 100) / 10).toString().replace(/\.0$/, '') + 'k' : String(n);
      $('#ghc').textContent = t; $('#ghn').hidden = false;
      $('#gh').setAttribute('aria-label', 'GitHub repository, ' + t + ' stars');
    };
    try { const c = JSON.parse(localStorage.getItem(K)); if (c && Date.now() - c.t < 36e5) return show(c.n); } catch (e) {}
    fetch(u).then(r => r.ok ? r.json() : null).then(d => {
      if (!d || typeof d.stargazers_count !== 'number') return;
      show(d.stargazers_count);
      try { localStorage.setItem(K, JSON.stringify({ n: d.stargazers_count, t: Date.now() })); } catch (e) {}
    }).catch(() => {});
  })();

  // mobile sidebar
  const mb = $('#menu'), side = $('#side');
  mb.addEventListener('click', () => { const o = side.classList.toggle('open'); mb.setAttribute('aria-expanded', String(o)); });

  // copy buttons: wrap each pre
  document.querySelectorAll('article pre').forEach(pre => {
    pre.tabIndex = 0; const w = el('div', 'pre-wrap'); pre.parentNode.insertBefore(w, pre); w.appendChild(pre);
    const b = el('button', 'copy', 'Copy'); b.type = 'button'; b.setAttribute('aria-label', 'Copy code');
    b.addEventListener('click', () => {
      const text = pre.textContent.replace(/\n$/, '');
      const ok = () => { b.textContent = 'Copied'; say('Copied to clipboard'); setTimeout(() => { b.textContent = 'Copy'; }, 1500); };
      const pick = () => { const r = document.createRange(); r.selectNodeContents(pre); const s = getSelection(); s.removeAllRanges(); s.addRange(r); say('Press Ctrl or Cmd C to copy'); };
      try { navigator.clipboard.writeText(text).then(ok, pick); } catch (e) { pick(); }
    });
    w.appendChild(b);
  });

  // heading anchors + "On this page"
  const heads = [...document.querySelectorAll('article h2[id], article h3[id]')];
  const list = $('#toc-list'), links = new Map();
  heads.forEach(h => {
    const a = el('a', 'anchor', '#'); a.href = '#' + h.id; a.setAttribute('aria-label', 'Link to this section'); h.appendChild(a);
    if (!list) return;
    const li = el('li'), l = el('a', h.tagName === 'H3' ? 'l3' : '', h.firstChild.textContent); l.href = '#' + h.id;
    li.appendChild(l); list.appendChild(li); links.set(h, l);
  });
  if (!heads.length && $('#toc')) $('#toc').hidden = true;

  // scroll-spy
  if (heads.length && 'IntersectionObserver' in window) {
    let active = null;
    const set = h => { if (active === h) return; if (active) links.get(active).classList.remove('on'); active = h; links.get(h).classList.add('on'); };
    const onScroll = () => {
      let c = heads[0];
      for (const h of heads) { if (h.getBoundingClientRect().top <= 100) c = h; else break; }
      set(c);
    };
    addEventListener('scroll', onScroll, { passive: true }); onScroll();
  }

  // wrap tables so they scroll inside themselves
  document.querySelectorAll('article table').forEach(t => { const w = el('div', 'tw'); w.tabIndex = 0; w.setAttribute('role', 'region'); w.setAttribute('aria-label', 'Table'); t.parentNode.insertBefore(w, t); w.appendChild(t); });
})();
