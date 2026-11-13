/* The plain documents (privacy, terms, guidelines, licences): each section gets an address,
   and the list of sections is drawn beside the text on a wide screen, above it on a phone. */
(() => {
  const main = document.querySelector('main.legal');
  const toc = document.querySelector('[data-toc]');
  if (!main || !toc) return;
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  const heads = [...main.querySelectorAll('h2')];
  if (heads.length < 3) { toc.remove(); return; }
  const used = new Set();
  heads.forEach((h, i) => {
    if (!h.id) { let id = slug(h.textContent) || `s${i + 1}`; while (used.has(id)) id += '-2'; h.id = id; }
    used.add(h.id);
    h.dataset.n = String(i + 1).padStart(2, '0');
  });
  const det = document.createElement('details');
  det.className = 'lg-toc__d';
  if (matchMedia('(min-width: 1100px)').matches) det.open = true;
  const sum = document.createElement('summary');
  sum.textContent = document.documentElement.lang === 'ar' ? 'في هذه الصفحة' : 'On this page';
  det.append(sum);
  const ol = document.createElement('ol');
  for (const h of heads) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#${h.id}`; a.textContent = h.textContent; a.dataset.for = h.id;
    li.append(a); ol.append(li);
  }
  det.append(ol);
  toc.append(det);
  addEventListener('resize', () => { if (matchMedia('(min-width: 1100px)').matches) det.open = true; });
  // The section being read, marked in the list.
  const links = new Map([...ol.querySelectorAll('a')].map((a) => [a.dataset.for, a]));
  const io = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) { links.forEach((a) => a.removeAttribute('aria-current')); links.get(e.target.id)?.setAttribute('aria-current', 'true'); }
  }, { rootMargin: '0px 0px -70% 0px' });
  heads.forEach((h) => io.observe(h));
})();
