# health.ojee.net — design system

The rules, tokens and components every screen is built from. `docs/DESIGN.md` is the direction and
what each screen shows; this file is how to build anything new so it matches.

Two companions, both in the repo:

- **The gallery**, `web/design-system.html` (live at https://health.ojee.net/design-system.html): every
  token and all 22 components below, in the app's own stylesheets, in light and dark. Its component
  markup is what the app's helpers render; update a section when its component's markup changes.
- **The tokens**, `docs/design-system/tokens.json` (a list per family, a usage note on each, both themes)
  and `tokens.css`, built from the CSS by `npm run design-tokens`, which also checks every text
  colour's contrast. Run it after changing a value in `app.css` or `system.css`, and commit both.

## Where things live

| what | where |
| --- | --- |
| Colour, space, radius, shadow and type tokens | `web/css/app.css` `:root` (light), `:root[data-theme="dark"]` and the `prefers-color-scheme` block (dark) |
| The tool-readable copy of all of them | `docs/design-system/tokens.json`, `tokens.css` (`npm run design-tokens`) |
| Control tokens (`--ctl-h`, `--hbtn`, `--fab`, `--float-*`, `--shadow-float`, `--press`, `--dur-*`) and shared component rules | `web/css/system.css`, loaded last |
| Fonts | `web/fonts/` (self-hosted; the CSP allows only this origin) |
| Icons | `web/js/lines.js` (line family), `web/js/icons.js` (generated Material Symbols; `scripts/make-icon-set.mjs`) |
| Component helpers | `web/js/ui.js` (seg, toggle, field, banner, empty, sheet, confirm, toast, busy), `web/js/apps.js` (st* settings rows), `web/js/kit.js` (mod, stat, ib), `web/js/medals.js`, `web/js/views/shared.js` (avatar), `web/js/views/ranks.js` (podium, entry) |

New CSS rules for a screen go in that screen's sheet and only **place** components (where, how far
apart). A rule that changes how a component looks goes in `system.css`, for every screen at once.
New JS or CSS files go in `web/sw.js` SHELL and `web/index.html`.

## The rules

Health is a calm, warm health app for one person and their friends: paper and ink, one colour per family of data, numbers first. These are the rules for building anything in it.

## Principles

- **Glance first.** Every first screen answers its question on one phone screen. Detail is one tap deeper. Nothing is removed, only moved.
- **Colour is data.** Each family of data has one hue; actions are ink. Never colour a button, a heading or a decoration with a family hue.
- **One of each.** One primary action per view, one Switcher per screen, one floating pill per side, one sheet at a time.
- **Calm motion.** Things arrive once and then stay. Nothing animates twice for the same arrival.
- **Plain words.** Say what is true and what to do, in a sentence.

## Content

- Sentence case everywhere: titles, buttons, labels ("Start one", "Who can join", "Hall of fame").
- Second person, present tense: "You asked to join. The owner decides." The app never says "I" or "we".
- Short sentences; full stops in helper and empty-state text, none in buttons and titles.
- Errors say what to do: "That code was not right. Type the new one.", "Between 4 and 12 hours." Never "Invalid" or "Error".
- Numbers with grouping and their unit: "34,770 steps", "7 h 30 min", "5:46 /km". Units follow the person's settings.
- No emoji and no religious symbols anywhere: not in copy, icons, art or tiles. No exclamation marks.
- Names are the person's display name; "You" for the viewer in lists.

## Colour

Two themes, the same names. Light is warm paper; dark is true black. The theme follows the device unless Me sets one.

- **Grounds.** `bg` is the page. `surface` is every card, sheet, row and input. `surface-2` is an inset on a card (tonal buttons, segmented controls, skeletons); `surface-3` is its pressed state.
- **Text.** `ink` for body and titles, `ink-2` for secondary values, `dim` for captions, kicks and units. All three hold 4.5:1 on `bg`, `surface` and `surface-2` in both themes.
- **Lines.** `line` for hairlines between rows and card edges; `line-strong` where a border must be seen (a chip, an input).
- **Actions.** `brand` (ink) with `on-brand` for the primary action and the Log button. `accent` (the sleep blue) for links, focus, switches that are on and a pill that needs a tap; `accent-soft` behind a ghost action.
- **States.** `ok`, `warn`, `bad` for text and marks on `surface`; their `-soft` versions are the grounds of banners and badges. A state always carries a word or an icon too. (`ok` on `ok-soft` is 4.38:1 in light: use it at 15px semibold and up.)
- **Families.** Each family has a mark colour `c-<family>` (rings, bars, lines, dots; 3:1 on a card) and a text colour `c-<family>-t` (4.5:1). Families: steps, active (active minutes, cardio), energy (calories), workouts, heart, sleep, recovery, body, vitals, nutrition, water, mind, cycle. Sleep stages: `c-deep`, `c-rem`, `c-light`, `c-awake`.
- **Tiles.** A family tile on Today and Health is solid `tile-<family>` with `on-tile-<family>` text and `tile-mark-<family>` for its ring. In dark the tiles are deep and their marks bright.
- **Medals** use only their metal: gold, silver, bronze, platinum, with a two-tone ribbon. Never tint one with a family hue.
- `scrim` behind a sheet. `raise` for the thumb of a segmented control.

## Type

- **Instrument Sans** (`--font-sans`) for all text and numbers. Numbers are semi-condensed (`font-stretch: 88%`) and tabular.
- **Newsreader** (`--font-serif`) only for a tab's title (`tab-title`), a sheet's title (`sheet-title`), the cover of a big moment (an empty state's title, the hall of fame's name). Never for body copy.
- Body is `body` (16px / 1.45). Secondary lines are `t-s`. Group labels and kicks are `label` in `dim`. Captions and units are `t-cap`.
- Deeper screens (with a back arrow) title in `screen-title`, the sans at 600.
- Big numbers: `stat-xl` on a tile, `stat-l` on a podium or hero, `stat` in a module. The unit follows the number at `t-m` in `dim`.
- Inputs are at least 16px, so phones do not zoom.

## Space and layout

- The scale is `s-1` 4px to `s-8` 44px. Card padding is `s-4` (16px); gaps inside a group `s-2`; between page sections `s-6`.
- The phone gutter is `page-pad` (16px). From 960px the side rail (`rail-w`) holds the tabs and the page caps at 1384px.
- A screen's switch and its controls stop at 560px on a wide screen; the feed reads at 640px.
- On a wide screen a board splits: where you stand (podium, last week) on the left, held in view; everybody on the right.
- Every page ends 32px above the floating tab bar (`tab-h` plus the safe area); 32px from the foot on a wide screen. Anything floating over the foot (a `FloatingPill`) adds its own height.

## Shape and depth

- Radii: `r-s` for small insets, `r-m` for inputs and small cards, `r-l` for cards, groups and sheets, `r-full` for every button, chip, switch and pill.
- Cards on `bg` carry `edge` (a 1px inner line), not a border. Lifted things carry `shadow-1`; things over the page (sheets, the tab bar) `shadow-2`; floating pills `shadow-float`.
- No gradients except a medal's metal. No coloured left borders on cards.

## Controls

- Heights: `ctl-h` (48px) for a button, `ctl-h-s` (44px) for a small button, an icon button and a floating pill, `ctl-h-xs` (34px) only for an action inside a list row. Header buttons are `hbtn` (40px); the Log button is `fab` (62px).
- **Button** for actions; **RowAction** only at the end of a row; **IconButton** for known icons; **HeaderButton** for everything in a page header; **LogButton** once, beside the tab bar; **FloatingPill** for one live value or one filter that must stay in reach.
- **Switcher** once per screen for its views; **Segmented** inside a card; **Chip** for filters; **Toggle** for a setting that saves at once.
- A choice of three or more opens a sheet (`stPick`), never a dropdown.
- Press feedback: buttons scale to 0.96–0.98 (`--press`); the Log button to 0.94.

## Motion

- Easing: `--ease` (a fast-out curve) for most changes; `--spring` for thumbs, highlights and things that land; `--ease-io` for both ways at once.
- Durations: 160ms for a press or a colour, 320ms for a switch or a floating pill arriving, 460ms for a sheet rising.
- Screens push and pop sideways; tabs slide; a screen's blocks rise in on first paint; numbers count up; rings fill.
- A thing arrives once. A redraw while it is up does not replay its entrance.
- Sheets follow the finger and spring back; let go past a third, or flick, and they close.
- Everything honours reduced motion: arrivals become instant, nothing slides.

## Iconography

- One line family, 1.75 stroke, rounded ends (shapes after Lucide), drawn inline by `ic(name)`; where there is no line icon, a generated Material Symbols Rounded glyph. No icon font, nothing fetched.
- Metric icons are filled and take their family's colour; action icons are outline in `ink` or `ink-2`.
- Icons stand beside a word, except well-known ones in an IconButton with an `aria-label`.
- The app's mark is the heart (assets: Logos). Never redraw it.

## Accessibility

- Text 4.5:1 on its ground in both themes; marks, borders and focus rings 3:1.
- Focus shows as a 2px `accent` outline, 2px off the element, while the keyboard is in use (the root gets `.kbd`); a field shows an `accent` border with an `accent-soft` halo. Never remove either without a replacement.
- Every icon-only control has an `aria-label` that includes any count ("Friends, 1 waiting").
- Touch targets are at least 44px; a 34px RowAction sits in a row that is the person's target.
- State is never colour alone: a word, an icon or a position goes with it.

## Outside the app

A page outside the app (a share card, an email, a status page) loads `docs/design-system/tokens.css` and uses the same names. Inside the app, `web/css/app.css` and `system.css` already declare them.

## Components

### Button
The action button: a pill with a label, and an icon when it helps.

#### When to use
- `btn` (ink on `brand`): the one primary action of a screen or sheet (Save, Start one, Accept).
- `btn--tonal` (`surface-2`): secondary actions beside it (Cancel, Hall of fame).
- `btn--ghost` (`accent` text, no fill): a low-weight link-like action (See all).
- `btn--danger` (`bad` on `bad-soft`) for a destructive choice; `btn--solid-danger` only in a confirm that deletes for good.
- Sizes: default 48px (`ctl-h`) in forms and sheets; `btn--s` 44px (`ctl-h-s`) in cards, heroes and page headers; `btn--block` fills its column.

#### What the consumer provides
A `<button type="button">` (or `<a>`) with the classes, a label of one to three words in sentence case, and an optional `ic(name, { size: 's' })` before the label. `is-busy` while it works (the label hides, a ring spins: `busy(btn, fn)` in ui.js sets it); `disabled` when it cannot be used.

#### Do / don't
- One `btn` per view. Two primaries side by side: make one `btn--tonal`.
- Group buttons in `.btnrow` (8px gap, `s-2`); right-align a dialog's in `.btnrow--end`.
- Never colour a button with a family hue. Colour is for data; actions are ink.

### RowAction
A small pill inside a list row: the row's own action (Accept, Add, Cancel), 34px tall (`ctl-h-xs`).

#### When to use
Only at the end of a row in a `.group`: friend requests, invitations, a circle to join. Everywhere else use `Button` with `btn--s`.
- `pill-btn--ink`: the row's yes (Accept, Join, Ask to join).
- `pill-btn--soft`: the row's no or a neutral one (Decline, Cancel, Add).

#### What the consumer provides
The row (`.row.fr-row` with `.fr-row__who` and `.fr-row__end`), and one or two `button.pill-btn` in the end slot, yes last.

#### Do / don't
- At most two per row. More choices: a `⋯` IconButton opening a sheet.
- The whole row is the tap target for the person; the pill is only for its action.

### IconButton
A round, borderless icon button (44px; `iconbtn--s` 36px) for actions that are known by their icon: more, close, search, refresh.

#### When to use
Inside cards, rows and sheets. In a page header use `HeaderButton` instead (the same element there gets the header look automatically).

#### What the consumer provides
`<button class="iconbtn" aria-label="…">${ic('more')}</button>`: the `aria-label` is required (the icon has no text). `is-busy` spins the icon.

#### Do / don't
- Only icons people already know. Anything else gets a label: a `Button`.
- `iconbtn--s` only where a row is dense (a set's remove, a ⋯ in a member list).

### HeaderButton
The round buttons at the top right of a page header: Me, Friends, Circles, Edit. 40px (`hbtn`), `surface` at 76% over the page, `edge` plus a `line` ring.

#### When to use
Every action in `.head__actions`. The profile button (`mebtn`) is always the last; screen actions come before it. A count waiting (requests, invitations) goes in a `pp-badge` in `c-heart`.

#### What the consumer provides
`head({ title, actions })` from ui.js places them. Use `a.pp-ib` for a link, `button.iconbtn` for an action (system.css gives both this look), each with an `aria-label` that says the count too ("Friends, 1 waiting").

#### Do / don't
- Three at most beside Me. More: move them into the screen.
- Never a labelled `Button` here except a screen's single main action on a deeper screen (Start one).

### LogButton
The round Log button: 62px (`fab`), `brand` with `on-brand`, beside the floating tab bar on a phone, in the rail on a wide screen.

#### When to use
It is the app's one floating primary action, on every tab. A screen with its own round action (the routine editor's +) puts it in this place instead.

#### What the consumer provides
Nothing: main.js mounts it with the tab bar. Screens only leave room for it (shell.css pads `.main`).

#### Do / don't
- Never a second round floating button on the same side. Other floating things are `FloatingPill`s, above it.

### FloatingPill
A pill floating over the foot of the page, above the tab bar: the live heart rate (left) and, on Boards, whose boards (right). 44px (`float-h`), frosted `surface` (92%), `shadow-float`, 14px semibold.

#### When to use
For one piece of live state or one filter that must stay in reach while the page scrolls. It sits 12px above the tab bar on a phone (above the Log button on the right), in the corner on a wide screen.

#### What the consumer provides
A `button` with an icon, a short label (truncates with an ellipsis) and, for a chooser, `chev_u`. The screen adds it as the last child of its view and removes it when it leaves; `.main` gets room for it automatically (shell.css `:has()`).

#### Do / don't
- It comes in once (`pp-fab-in`); a redraw adds `is-still` so it does not replay.
- `lpill.is-tap` (accent) only when it needs a tap (reconnect).
- One per side. Never words longer than a name.

### Chip
A toggle in a row of filters: outlined with `line-strong` when off, solid `ink` with `bg` text when pressed. 40px.

#### When to use
Filters that can combine or a choice among many that scrolls sideways (workout types, days of the week in `.chips--week`).

#### What the consumer provides
`button.chip` with `aria-pressed`, in a `.chips` row.

#### Do / don't
- Two to four exclusive choices: `Segmented` instead.
- Labels of one word.

### Segmented
A compact switch of a few exclusive options inside a card: the period on a board (Today, Week, Month, All time), a unit.

#### When to use
Two to five short options that change what a card shows. `seg--fit` sizes it to its content; without it, it fills its row.

#### What the consumer provides
`seg(name, [[value, label]…], current, { label, fit })` from ui.js; listen for clicks on `[data-seg="<name>"]`. The chosen option gets `aria-pressed="true"` and the `raise` thumb.

#### Do / don't
- The screen-level switch (Feed / Boards) is `Switcher`, not this.

### Switcher
The full-width switch between a screen's two or three views (Feed / Boards), with a thumb that slides (`--spring`, 320ms).

#### When to use
Once per screen, right under the header, for views of the same thing. On a wide screen it stops at 560px.

#### What the consumer provides
`.segx` with `--n` (options) and `--i` (chosen), each `button.segx__o` with `aria-pressed`. Move it with `segxTo()` so the thumb slides instead of redrawing.

#### Do / don't
- Never two Switchers stacked. A second choice is a `FloatingPill` or a `BoardPicker`, not another bar.

### Toggle
An on/off switch: `accent` when on. For a setting that applies at once.

#### What the consumer provides
`toggle(name, checked, { label, disabled })` from ui.js; inside settings, `stSwitch()` puts it at the end of a row. The `label` is read out (`aria-label`).

#### Do / don't
- It saves on change: no Save button with toggles.

### Field
A labelled input or select with a hint under it, and an error slot.

#### What the consumer provides
`field({ label, name, type, value, hint, attrs, options })` from ui.js; `fieldError(form, name, message)` writes an error under it. Inputs are `surface` with a `line-strong` edge, 16px text (so phones do not zoom).

#### Do / don't
- Labels are nouns in sentence case; hints say the rule ("2 to 40 characters.").
- Errors say what to do ("Between 4 and 12 hours."), never "Invalid".
- No `autofocus` in a sheet on a phone (the sheet strips it so the keyboard does not cover it).

### SettingsRow
Rows in a rounded group: the settings pattern (Me and every settings screen). A row has an icon in its family tint, a title, a line under it and a value or control at the end.

#### What the consumer provides
From apps.js: `stLab(text)` above a group, `stGrp(rows)`, `stRow({ icon, fam, title, sub, value, btn, href })`, `stSwitch(…)`, `stRadio(…)`, `stNote(text)` under it, `stPick({ title, options, current })` for a choose-one sheet.

#### Do / don't
- A row that opens a choice shows the current value in `dim` and a chevron.
- A choice of three or more opens `stPick`, never a dropdown.

### Banner
A message in the flow of the page: neutral (`surface` with an icon), `warn` or `bad`, with an optional action.

#### When to use
Something about this screen the person should know or fix (a private board, a lost connection). Short-lived news is a toast; a missing list is an `EmptyState`.

#### What the consumer provides
`banner({ tone, iconName, title, text, actions })` from ui.js. `bad` banners get `role="alert"`.

#### Do / don't
- Title says what is true, text says what to do.

### EmptyState
What a list or card shows when it has nothing: an icon, a title, one or two sentences and at most one action.

#### What the consumer provides
`empty({ iconName, title, text, action })` from ui.js, usually inside `.mod.mod--12`.

#### Do / don't
- Say why it is empty and the one thing that fills it ("Start one", "Find friends").

### Avatar
A person: their photo, or their initials on their colour (`accent` of the profile, else `surface-2`). `avatar--l` on a profile.

#### What the consumer provides
`avatar(person, { large })` from views/shared.js with `{ username, displayName, accent, avatar }`.

#### Do / don't
- Always beside the name; an avatar alone needs an `aria-label` on its link.

### Medal
A medal (gold, silver, bronze; platinum for achievements) under a two-tone ribbon, the icon of what it was for pressed in; and achievement cards in the metal reached.

#### When to use
Bests beaten in a workout (gold: ever, silver: a year, bronze: 90 days), the trophy case on a profile, the hall of fame.

#### What the consumer provides
`medal(tier, icon, { size: 's'|'m'|'l', fresh })`, `achGrid(list, { own })` from medals.js. `fresh` turns it in and runs the shine once.

#### Do / don't
- The metal is the only colour on a medal: never tint one with a family hue.
- `s` in a line of text has no icon.

### Tile
A family tile on Today and Health: the family's solid colour (`tile-<family>`) with `on-tile-<family>` text, its icon, a big number (`stat-xl`) and one line under it.

#### When to use
The glance: one number per family that answers its question. Detail is one tap deeper.

#### What the consumer provides
`.bt.bt--<family>` with the stat markup from kit.js (`stat({ size, label, value, unit, context, href })`). Rings and bars on it use `tile-mark-<family>`.

#### Do / don't
- Colour is read before words, but the label always names the family.
- Never two tiles of the same family on one screen.

### Podium
A board's head: the family tile colour, the period (`Segmented`), when the week turns, your place in `stat-l`, the gaps either side, and the top three on steps.

#### What the consumer provides
`podium(board, period)` from views/ranks.js with the board the API returns.

#### Do / don't
- It always says where you are, also when you are not listed (and why).

### LeaderboardRow
A row on a board: rank and movement, avatar, name with weeks won (a small medal), a bar against the leader, the last 7 days, the value and its trend.

#### What the consumer provides
`entry(e, board)` from views/ranks.js inside `.pp-board .lbs`. Your own row is `lb--me` and pins to the foot while it is scrolled away.

#### Do / don't
- The number is the value; the bar only compares. Units follow the person's settings.

### BoardPicker
Which board is showing: the board's icon in its family tint, its name and group, dots for its place in the strip, a chevron for the full list.

#### When to use
The top of Boards. A tap opens every board in a sheet; a sideways swipe moves along the strip (the name slides in from that side).

#### What the consumer provides
`pickButton()` in views/people.js; the dots are the boards in order.

#### Do / don't
- Whose boards is not chosen here: that is the `FloatingPill`.

### TabBar
The floating tab bar on a phone: four tabs (Today, Health, Train, People) with a sliding highlight, frosted `surface` over the page, `shadow-2`. From 960px it becomes the side rail with Me as a fifth entry.

#### What the consumer provides
Nothing: main.js builds it. A screen marks its tab with `tab` in its route.

#### Do / don't
- Four tabs, always. A screen with its own controls at the foot (recording) hides it as a task.

### Sheet
The sheet: everything that is chosen, confirmed or edited over a screen. From the bottom on a phone (drag down or flick to close, it springs back), centred on a wide screen. Title in `sheet-title` (Newsreader).

#### What the consumer provides
`sheet({ title, body, foot })` from ui.js, or `stPick`, `stInfo`, `confirm`, a `formSheet`. Cancel and the primary go in `foot`, primary last.

#### Do / don't
- Opens without the keyboard on a phone and without a jump (focus moves without scrolling).
- One question per sheet. A sheet over a sheet only for a confirm.
