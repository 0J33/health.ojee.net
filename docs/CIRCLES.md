# Circles, who sees you, and passwords

Three changes that land together (v123): **Circles** (groups of people with
their own leaderboards and a weekly hall of fame), a new **privacy model**
(no public or private accounts; each kind of data has an audience), and
**passwords** (change it, or get back in without email or a phone number).

## 1. Who sees you

### The account: public or private (v124)

- **Public** (the default) works as it always did: you are in friend
  suggestions and the people list, on the Everyone boards, and your profile
  is open to anybody, signed out too, showing what you share with everyone.
- **Private**: nobody finds you except by typing your username exactly (any
  case); a stranger who does sees your name, colour and photo and can ask to
  be friends. You are never suggested, never on an Everyone board, and
  signed out your profile does not exist. Your friends and the people in
  your circles still see what you share with them.

(v123 had dropped the switch; v124 brought it back. Rows saved by v123 become
public with what they shared seen by everyone, as before v123, unless every
kind was kept to the person: then private.)

### Who sees each kind

Each kind (`activity`, `workouts`, `sleep`, `heart`, `body`) has an audience:

| audience   | who sees it |
|------------|-------------|
| `everyone` | anybody who can see the account (default for activity and workouts); for a private account, its friends and circles |
| `circles`  | your friends and everyone in a circle with you |
| `friends`  | your friends only |
| `me`       | nobody but you (default for sleep, heart and body) |

`feed` stays a switch. The feed itself is friends only, as before. Older apps
send `true` / `false`: `true` reads as `everyone`, `false` as `me`.

`presence` says whether others see when you are online and what workout or
route you are doing right now (server/presence.js, People's Now strip, a line
under a profile's name). It is `'auto'` until chosen, which is on for a public
account and off for a private one. Those who see it are everybody signed in
who may see the account; what the workout is needs `workouts`, the live bpm
needs `heart`. It is kept in memory only: an open tab says "here" every 45 s,
and the running workout is read from the log when it starts, changes or ends.

### Where it is enforced

`server/audience.js` holds the rule (`lensOf(app, viewer)`: `knows`, `sees`,
`listed`). Write time: a kind set to `me` is written to the shared tables as
NULL. Read time: every board, profile, compare, route and shared routine asks
the lens again, so a change takes effect at once. Shared routes, routines and
exercises are seen by whoever may see their maker.

## 2. Circles

A circle is a named group with its own boards. Anybody can start one.

### What a circle has

- name (2-40 characters), a line about it (up to 160), a colour;
- an **owner** (who started it, or who it was handed to) and members;
- how people get in: **by request** (listed under Find a circle; anyone may
  ask, the owner says yes or no) or **by invitation only** (not listed; the
  owner invites friends).

### What people can do

| who | can |
|-----|-----|
| anybody | browse listed circles (name, about, member count; never the members), ask to join, take a request back |
| invited | accept or decline |
| member  | see the members and the circle's boards and winners, leave |
| owner   | accept or decline requests, invite friends, remove members, rename, change about, colour and how people get in, hand the circle to another member, delete it |

The owner cannot leave without handing the circle over or deleting it.
Limits: 100 members a circle, 10 circles started per person, 25 circles
joined.

### Boards

The boards have three kinds of scope, picked with the "Whose" button:

- each of your circles (by name): its members;
- **Friends**: you and your friends;
- **Everyone**: public accounts, and your friends and circles.

The default is the circle you last looked at, else your first circle, else
Friends. A person is on a circle's board for a kind only if its audience
lets the viewer see it: `everyone` and `circles` always, `friends` only for
viewers who are their friends. Boards in a circle always use the shared week (Friday
12:00 UTC), so a week means the same thing to everybody in it.

### Weekly winners

When the shared week turns over, each circle's winners of that week are
kept for good: for every board, whoever was first (ties all win). Only
members whose audience for that kind is `everyone` or `circles` count, so a winner is
someone everybody in the circle can see. The record is a snapshot: it stays
when someone leaves.

- Kept in `circle_win (circle_id, week, metric, user_id, value)`.
- Written by the minute tick when the week turns (winners are told with a
  notification: "You won the week in Steps, in Ojee & co"), and filled in
  on read for any closed week since the circle started that is missing.
- A new circle starts with its last 4 closed weeks filled in from its
  members' history, so it does not open empty.

Shown on the circle's page as **Hall of fame**: last week's winner of each
board, the most weeks won (by person, with their best boards), and every
week before, newest first. A board in circle scope shows each person's wins
on that board next to their name.

The Friends scope has no kept history (it is different for every viewer):
its board says who won last week, worked out when asked.

### API

| method | path | what |
|--------|------|------|
| GET  | `/api/circles` | `{ mine, invites, requests }`: your circles (with your role and, for owners, how many are waiting), invitations, requests you sent |
| GET  | `/api/circles/browse?q=` | listed circles you are not in |
| POST | `/api/circles` | start one: `{ name, about, accent, join }` |
| GET  | `/api/circles/:id` | the circle; members and requests for members |
| PATCH| `/api/circles/:id` | owner: `{ name, about, accent, join, owner }` |
| DELETE | `/api/circles/:id` | owner: delete it |
| POST | `/api/circles/:id/join` | ask (or accept an invitation) |
| POST | `/api/circles/:id/leave` | leave, or take back a request, or decline an invitation |
| POST | `/api/circles/:id/invite` | owner: `{ username }` (a friend) |
| POST | `/api/circles/:id/members/:username/accept` | owner |
| POST | `/api/circles/:id/members/:username/decline` | owner |
| DELETE | `/api/circles/:id/members/:username` | owner: remove |
| GET  | `/api/circles/:id/winners?weeks=` | hall of fame |
| GET  | `/api/leaderboard?scope=circle:<id>` | a circle's board (also `/api/boards`) |

## 3. Passwords

Accounts have only a username and a password (shared with mtg.ojee.net and
dnd.ojee.net: one login), so there is no email to send a link to.

- **Change password** (Settings, Account): the current one and a new one.
  Every other session of the account is signed out, on all three sites.
- **Recovery code** (Settings, Account): made with your password, shown
  once, like `K7QF-2MPD-9XWA-H4TC`. Keep it somewhere safe. On the sign-in
  page, Forgot password, it sets a new password; then it is used up and a
  new one is shown. Making a new code replaces the old one.
- **Reset link from an admin**: an admin (Settings, Admin) makes a one-time
  link for a username, good for 24 hours, and sends it to the person however
  they talk. The link asks for a new password.

After any reset every session of that account is signed out and the person
is signed in on the device they reset from. Both ways are rate-limited per
address and per username. Codes and link tokens are stored only as hashes.
