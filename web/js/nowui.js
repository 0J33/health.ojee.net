/* Who is here now, and who is working out (GET /api/now, server/presence.js).

     nowStrip(d)   People's Now strip: working out first, as cards that say
                   what (the workout, the exercise and set, the route and its
                   distance, the bpm when their heart is shared), then
                   everybody else online, as faces with a dot
     nowBadge(n)   one line under a profile's name: "Online", or what they
                   are doing and for how long

   Each person chooses whether they show (Me, Privacy); it is on by default
   for a public account. */

import { html, ic } from './ui.js';
import * as f from './format.js';
import { avatar } from './views/shared.js';

const ROUTE = { RUNNING: ['Run', 'run'], WALKING: ['Walk', 'walk'], HIKING: ['Hike', 'hike'], BIKING: ['Ride', 'bike'], MOUNTAIN_BIKE: ['Mountain bike', 'bike'], ROLLERBLADING: ['Skate', 'sport'] };
const nameOf = (p) => p.displayName || p.username;

/** Minutes, then hours: "34 min", "1 h 05". */
function since(ms) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

/**
 * What somebody is doing, in words: { icon, what, doing, time }.
 * `at`: when the server said so (a route's moving time is as of then).
 */
export function doingOf(a, at = Date.now()) {
  if (!a) return null;
  const t = Date.now();
  if (a.kind === 'route') {
    const [word, icon] = ROUTE[a.type] || ['Route', 'route'];
    const ms = Number.isFinite(a.ms) ? a.ms + (a.paused ? 0 : t - at) : t - a.start;
    return {
      icon, what: a.type ? `${word}${a.paused ? ', paused' : ''}` : (a.paused ? 'Route, paused' : 'Recording a route'),
      doing: Number.isFinite(a.m) ? f.dist(a.m) : '', time: since(ms),
    };
  }
  const d = a.doing;
  return {
    icon: 'dumbbell',
    what: a.title || 'Working out',
    doing: a.resting ? (d ? `Resting · ${d.name} next` : 'Resting') : d ? `${d.name}${d.of ? ` · set ${d.set} of ${d.of}` : ''}` : (a.sets ? f.plural(a.sets, 'set') : ''),
    time: since(t - a.start),
  };
}

const heart = (bpm) => (bpm ? html`<span class="nw__hr">${ic('heart', { size: 's' })}<b class="n">${bpm}</b></span>` : '');

function card(p, at) {
  const w = doingOf(p.activity, at);
  return html`<a class="nw__card" href="/u/${encodeURIComponent(p.username)}" aria-label="${nameOf(p)}: ${w.what}${w.doing ? `, ${w.doing}` : ''}, ${w.time}${p.bpm ? `, ${p.bpm} bpm` : ''}">
    <span class="nw__face">${avatar(p)}<span class="nw__ic">${ic(w.icon, { size: 's' })}</span></span>
    <span class="nw__txt">
      <b class="nw__n">${nameOf(p)}</b>
      <span class="nw__what">${w.what}</span>
      ${w.doing ? html`<span class="nw__doing">${w.doing}</span>` : ''}
      <span class="nw__meta"><span class="n">${w.time}</span>${heart(p.bpm)}</span>
    </span>
  </a>`;
}

const face = (p) => html`<a class="nw__p" href="/u/${encodeURIComponent(p.username)}" aria-label="${nameOf(p)}, online">
  <span class="nw__face">${avatar(p)}<span class="nw__dot" aria-hidden="true"></span></span><small>${nameOf(p)}</small></a>`;

/** The Now strip, or nothing when nobody is here. */
export function nowStrip(d) {
  const people = d?.people || [];
  if (!people.length) return '';
  const act = people.filter((p) => p.activity);
  const idle = people.filter((p) => !p.activity && p.online);
  const on = people.filter((p) => p.online).length;
  const words = [act.length ? `${act.length} working out` : '', on ? `${on} online` : ''].filter(Boolean).join(' · ');
  return html`<section class="nw" aria-label="Now">
    <div class="nw__h"><h2><span class="nw__live" aria-hidden="true"></span>Now</h2><small>${words}</small></div>
    <div class="nw__row">${act.map((p) => card(p, d.at || Date.now()))}${idle.map(face)}</div>
  </section>`;
}

/** Under a profile's name: online, or what they are doing now. */
export function nowBadge(n, at = Date.now()) {
  if (!n) return '';
  if (n.activity) {
    const w = doingOf(n.activity, at);
    return html`<p class="nw-badge nw-badge--act"><span class="nw__live" aria-hidden="true"></span>${ic(w.icon, { size: 's' })}<span>${w.what}${w.doing ? html` · ${w.doing}` : ''} · <span class="n">${w.time}</span>${n.bpm ? html` · ${heart(n.bpm)}` : ''}</span></p>`;
  }
  return n.online ? html`<p class="nw-badge"><span class="nw__dot nw__dot--in" aria-hidden="true"></span>Online now</p>` : '';
}
