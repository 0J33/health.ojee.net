/* Report and Block, wherever someone else's post, comment or profile is shown
   (server/safety.js). A report goes to the people who run rep.; a block hides two
   people from each other at once, and the blocked person is not told. */

import { api } from './api.js';
import { html, sheet, confirm, toast, toastError, busy } from './ui.js';
import { stPick } from './apps.js';

const REASONS = [
  ['spam', 'Spam or scam'],
  ['harassment', 'Harassment or bullying'],
  ['hate', 'Hate or violence'],
  ['sexual', 'Nudity or sexual content'],
  ['self_harm', 'Self-harm or dangerous behaviour'],
  ['false_health', 'Dangerous health claims'],
  ['ip', 'Someone else\'s work or photo'],
  ['privacy', 'Shares someone\'s private information'],
  ['other', 'Something else'],
];

/** Report something: a reason, an optional note, sent. */
export async function report({ kind, id, what = 'this' }) {
  const reason = await stPick({ title: `Report ${what}`, lead: 'The people who run rep. look at every report, usually within two days. They are not told who reported it.', options: REASONS.map(([v, t]) => [v, t]), current: '' });
  if (!reason) return false;
  const s = sheet({
    title: 'Anything to add?',
    body: html`<div class="cn"><textarea class="input" name="note" rows="3" maxlength="500" placeholder="Optional: what is wrong with it"></textarea></div>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="button" class="btn" data-send>Send the report</button>`,
    cls: 'cn-sheet',
  });
  let sent = false;
  s.el.querySelector('[data-send]').addEventListener('click', async (e) => {
    try {
      await busy(e.currentTarget, () => api.post('/api/report', { kind, id, reason, note: s.el.querySelector('[name="note"]').value }));
      sent = true; s.close(); toast('Reported. Thank you.');
    } catch (err) { toastError(err); }
  });
  await s.closed;
  return sent;
}

/** Block someone, after saying what it does. Resolves true when blocked. */
export async function block(person) {
  const name = person.displayName || person.username;
  const yes = await confirm({ title: `Block ${name}?`, text: `You stop being friends, and neither of you sees the other's posts, comments, boards or profile, nor can find or ask the other. ${name} is not told. You can unblock them in Me → Privacy → Blocked people.`, yes: 'Block', danger: true });
  if (!yes) return false;
  try { await api.post('/api/block', { username: person.username }); toast(`${name} is blocked`); return true; } catch (err) { toastError(err); return false; }
}

/** The menu on somebody else's post: report it, or block its author. */
export async function othersPostMenu(p, { onBlocked } = {}) {
  const who = p.author || {};
  const opts = [['report', 'Report this post', 'Its words, photos, videos or music']];
  opts.push(['block', `Block ${who.displayName || who.username}`, 'Neither of you sees the other any more']);
  const v = await stPick({ title: 'This post', options: opts, current: '' });
  if (v === 'report') await report({ kind: 'post', id: p.id, what: 'this post' });
  if (v === 'block' && await block(who)) onBlocked?.();
}

/** The menu on somebody else's comment. */
export async function othersCommentMenu(c, { onBlocked } = {}) {
  const who = c.author || {};
  const v = await stPick({ title: 'This comment', options: [['report', 'Report this comment', ''], ['block', `Block ${who.displayName || who.username}`, 'Neither of you sees the other any more']], current: '' });
  if (v === 'report') await report({ kind: 'comment', id: c.id, what: 'this comment' });
  if (v === 'block' && await block(who)) onBlocked?.();
}

/** The menu on somebody else's profile. */
export async function personMenu(person, { onChange } = {}) {
  if (person.blocked) {
    const v = await stPick({ title: person.displayName || person.username, options: [['unblock', 'Unblock', 'You see each other again; friendship is not restored']], current: '' });
    if (v === 'unblock') { try { await api.post('/api/unblock', { username: person.username }); toast('Unblocked'); onChange?.(); } catch (err) { toastError(err); } }
    return;
  }
  const v = await stPick({ title: person.displayName || person.username, options: [['report', 'Report', 'Their name, photo or what they post'], ['block', 'Block', 'Neither of you sees the other any more']], current: '' });
  if (v === 'report') await report({ kind: 'person', id: person.username, what: person.displayName || person.username });
  if (v === 'block' && await block(person)) onChange?.();
}

/** Report one photo or video, from the viewer. */
export const reportMedia = (id) => report({ kind: 'media', id, what: 'this photo or video' });

void busy;
