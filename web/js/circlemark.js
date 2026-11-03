/* A circle's mark: its icon on its colour (server/circles.js ICONS and
   ACCENTS), the same wherever the circle appears: the Circles tab, its
   page, lists, the boards' scope button. Sizes: s 28, m 40, l 56, xl 72. */

import { html, ic } from './ui.js';

export const CIRCLE_ACCENTS = ['#2E7D5B', '#3E6FB4', '#B4543E', '#7A5BC9', '#C98A2E', '#2E8C9A', '#B43E7A', '#5E6B2E', '#D0612B', '#4A5BD0', '#1F8A70', '#8A4FB4'];
export const CIRCLE_ICONS = ['groups', 'run', 'bike', 'walk', 'hike', 'swim', 'dumbbell', 'strength', 'rowing', 'yoga', 'sprint', 'steps', 'flame', 'bolt', 'spark', 'target', 'trends', 'heart', 'sun', 'moon', 'landscape', 'globe', 'flag', 'hotel_class'];

export const circleMark = (c, { size = 'm' } = {}) => html`<span class="cmk cmk--${size}" data-style="--cc:${c?.accent || CIRCLE_ACCENTS[0]}" aria-hidden="true">${ic(c?.icon || 'groups')}</span>`;
