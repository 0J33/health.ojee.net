# Egypt's data protection law and rep.

Written 12 November 2026. This is research, not legal advice. Items marked **[unsure]** were not
confirmed in the law's text or on a page the PDPC runs. Check them before you rely on them.

Law: Personal Data Protection Law No. 151 of 2020 (PDPL). Executive Regulations: Minister of
Communications Decree No. 816 of 2025, issued 1 November 2025. The one-year grace period ended on
31 October or 1 November 2026; sources give both dates. Regulator: the Personal Data Protection
Center (PDPC), https://pdpc.gov.eg.

## What the law asks of rep.

- rep. is a **controller**. The controller is the owner, as a natural person. Almost everything rep.
  keeps is **sensitive data**: health data, and children's data, which rep. now avoids by being 18+.
- **Permission from the PDPC before processing.** Companies get a *licence*, valid for 3 years.
  Natural persons and short-term processing get a *permit*, valid for up to 1 year. The PDPC portal
  has a separate flow called "Permit for liberal profession", which is the route for an individual.
  It identifies you by a Tax Registration Number (TRN), checked with the Egyptian Tax Authority (ETA).
- **Sensitive data** needs explicit written consent and the PDPC's approval. The MENA
  Associates/Amereller alert describes a separate sensitive-data licence. On the portal, a
  questionnaire decides which licences and permits apply. **[unsure]** Whether one liberal-profession
  permit covers sensitive data and transfers, or whether each is a separate item.
- **Transfers abroad** need the PDPC's approval, the data subject's consent, and a destination with
  protection "not lower than" Egypt's. You also need a transfer impact assessment. The fee is 50% of
  the base licence or permit fee.
- **DPO.** The law requires a data protection officer, who must be registered with the PDPC. To
  register, a DPO passes the PDPC exam and uploads documents. For legal entities, the DPO register
  number is *required*. On the liberal-profession permit form it is labelled **"(Optional)"**.
- **Records of processing (ROPA)**, retention periods, a way to exercise rights, and security measures.
- **Breach notification.** Tell the PDPC within 72 hours, through its portal or hotline. Tell the
  people affected within 3 working days of telling the PDPC.
- **Fees.** Licence fees are exempt for 1 to 100,000 records. Permit fees are exempt for 1 to 25,000
  records. Each data subject counts as one record. The exemption covers the fee only, not the duty to
  get the permit. The cross-border fee is 50% of the base fee, so it is probably also zero
  **[unsure]**.

## What you (the owner) can do yourself, step by step

1. **Digital identity.** Create a Digital Egypt identity linked to your national ID
   (https://digital.gov.eg). The PDPC portal signs you in only through Digital Egypt.
2. **PDPC account.** Go to https://pdpc.gov.eg/register-start. Verify with Digital Egypt, then give
   your name (4 parts), national ID, phone, and a *personal* email (Gmail, Outlook, Proton and similar).
   Verify the email. Log in later at https://pdpc.gov.eg/login. (Some guides list
   `portal.pdpc.gov.eg`. That host did not resolve on 12 Nov 2026, and the services run on pdpc.gov.eg.)
3. **Free questionnaire first.** "PDPC Compliance Questionnaire" says which licences or permits apply.
   It is not an application. Use the answers in this file: health data, under 25,000 people,
   transfers to the US and elsewhere, no direct marketing, no CCTV.
4. **Tax Registration Number.** The liberal-profession permit starts with "Verify TRN with ETA" (TRN
   plus the taxpayer name exactly as ETA has it). If you have no TRN as a freelancer or liberal
   profession, register with the Egyptian Tax Authority first (https://eta.gov.eg). **[unsure]**
   Whether ETA accepts "software developer running an app" as a liberal profession. Ask ETA.
5. **E-signature token.** Every uploaded document must be a PDF (version 1.7 or later, 1 MB or less)
   digitally signed through ITIDA. You need a USB token from an ITIDA-licensed provider (list:
   https://itida.gov.eg, "E-Signature Providers"), activated, plus the portal's "websignClient" app.
   This is the main cost and wait you can start now.
6. **Criminal record certificate** (فيش جنائي), recent, scanned to PDF and signed.
7. **Templates.** Download the "Declaration of Accuracy and Authenticity" and the "Compliance
   checklist" from https://pdpc.gov.eg/guidelines ("Templates"). Fill them in, sign with the token,
   and do not change their wording or order.
8. **Apply.** Go to https://pdpc.gov.eg/services/liberal-profession, then "Permit for liberal profession".
   The steps are ETA verification, questionnaire, upload (criminal record, declaration, checklist,
   optional DPO number), and fees. The request type is Permit, for 12 months. The PDPC may ask for
   more documents through "Upload Additional Documents". The portal says review takes 1 to 2 weeks.
   The regulations allow 90 working days.
9. **DPO, if they ask for one** **[unsure]**. Either (a) appoint a certified DPO from the portal's
   list (search, connect, appoint). That person is usually paid, and they sign a non-compete
   declaration. Or (b) become a certified DPO yourself through "DPO Certificate": pass the PDPC DPO
   exam first, then upload your degree, criminal record, 4x6 photo, course certificates, employment
   references, the exam certificate and the declaration, and pay an admin fee. DPOs are graded
   A/B/C by data volume and sensitivity, and registration lasts 2 years. No source says whether a
   controller may be their own DPO. The non-compete and independence rules point against it.
10. **Renew** one month before the permit ends. A permit lasts 12 months.
11. **Keep** this file, the ROPA below, docs/INCIDENT.md and the signed PDFs together. Inspectors can
    ask for them.

Can do now, without the PDPC: steps 1, 2, 3, 4, 5, 6, the ROPA, the Arabic notice (see gaps), and
the transfer assessment below.

## What is already done in the app

- **Privacy policy** (web/privacy.html, updated 12 Nov 2026). It names the controller and contact
  (contact@ojee.net), lists every category, service and foreign recipient, and covers retention,
  rights, a 30-day answer time, and the right to complain to the PDPC.
- **Consent records** (server/consent.js, stored on the profile as timestamps):
  - `terms` covers Terms, Privacy, and being 18 or older, and is taken at signup (server/app.js, `b.accept`).
  - `health` covers processing health data and syncing it with connected services. It is asked
    once, before anything is read.
  - `sharing` covers what friends, circles and boards see.
  - `ai` covers AI summaries. It is off by default and records each kind of data allowed.
    Data that came only from Strava is never sent.
- **18+ only.** The signup box, Terms ("You must be 18 or older") and the Children section in the privacy policy.
- **Export.** `GET /api/export` returns all of a person's data as JSON, or the daily table as CSV
  (Me, Your data, Export).
- **Correction.** Every entry and workout can be edited or deleted.
- **Deletion.** `POST /api/account/delete-data` wipes health data but keeps the login.
  `POST /api/account/delete` (username plus password) removes the login and its sessions, wipes all
  data, revokes Google, and deauthorizes Strava. Backups age out within 30 days.
- **Breach plan.** docs/INCIDENT.md sets out: detect, contain within the hour, assess within 24 h,
  tell users within 72 h, tell the PDPC within 72 h, then fix and log.
- **Encryption.**
  - In transit: TLS to Cloudflare, then an encrypted tunnel to the server.
  - Connection tokens and keys (Strava, Hevy, Garmin, Xiaomi, own AI key): AES-256-GCM, with a key
    derived from `APP_SECRET` and bound to the person's id (server/secrets.js).
  - Passwords: bcrypt. Personal API keys: SHA-256 hashes.
  - Backups: every 6 h, AES-256 encrypted (deploy/backup.sh). 28 are kept on the server and 120 on
    the operator's NAS, both in Egypt.
- **Minimisation.** Photo EXIF data is stripped. Route ends are trimmed 200 m. Map tiles are proxied.
  Weather uses a position rounded to about 1 km. Five sensitive groups (nutrition, mood, symptoms,
  cycle, ECG) are off by default.

### Gaps found while writing this

- **The data directory is not encrypted at rest yet.** deploy/encrypt-data.sh exists, but on
  12 Nov 2026 `findmnt` showed `~/health-server/data` is not a mount. Run the script on the box.
- **No Arabic version** of the privacy policy or the consent screens. Law-firm summaries say consent
  must be in Arabic **[unsure of exact wording]**.
- **Consent records keep only a time.** They do not record which policy version or text was shown.
  Store a version or hash with each one.
- **Transfer abroad.** The `health` consent covers "syncing with connected services". It does not
  say in words that data goes outside Egypt. Add that sentence to the consent screen.
- **INCIDENT.md step 4.** The law counts from the PDPC notice: users within 3 working days *after*
  notifying the PDPC. Step 4 says 72 h from awareness. It is not wrong, but name the PDPC portal or
  hotline as the channel.
- **Server log retention.** The privacy policy says "a few days", but nothing in deploy/ sets it.
  Set `MaxRetentionSec` in journald on the box.

## Record of processing activities (ROPA)

Controller: the owner of rep. (a natural person), Egypt; put your full name here when you file. Contact: contact@ojee.net. Service: rep.
(https://rep.ojee.net and its Android app). DPO: none yet, see step 9.

Data subjects: registered adult users (18+), mostly resident in Egypt. Fewer than 100,000, and
under 25,000 today **[fill in the real count]**. Friends and commenters are also users. There are no
employees.

Storage: one server in Egypt (the operator's machine). There is one SQLite database for each person
plus an app database. Encrypted backups are kept on that server and on a second machine (NAS) in Egypt.

| # | Purpose | Data categories | Legal basis | Recipients (country) | Retention | Security |
|---|---|---|---|---|---|---|
| 1 | Account and sign-in (rep.'s own login since v296) | username, Google/Apple account ID and email, bcrypt password hash (review accounts only), session cookie | consent at signup; performing the service | none outside the operator | until account deletion | provider ID-token checks, rate limits, HttpOnly cookie, session tokens stored hashed |
| 2 | Profile | display name, bio, photo, time zone, city, units, goals, settings | consent | none | until deletion | per-person DB |
| 3 | Health tracking from connected services | **sensitive**: activity, steps, heart rate, HRV, VO2 max, sleep, weight, body fat, SpO2, temperature, blood glucose, breathing rate, device names | explicit consent (`health`) | Google Health API (USA), Health Connect (on the device), Hevy (EU/USA **[unsure]**), Strava (USA), Garmin (USA), Xiaomi (China/Singapore **[unsure]**), only those the user connects | until deleted by the user | tokens AES-256-GCM, TLS |
| 4 | Data the user logs | **sensitive**: workouts, sets, weigh-ins, food, water, mood, symptoms, cycle and ovulation, ECG result, notes | explicit consent; optional groups off by default | write-back to Google/Hevy/Strava only if the user chooses | until deleted | as above |
| 5 | Routes and location | GPS tracks, saved routes, live position while recording | explicit consent; Android permission | Strava (USA) if the user turns that on; friends | until deleted | ends trimmed 200 m; live map hides the first 200 m |
| 6 | Social features | posts, captions, photos, videos, cheers, comments, friends, circles, boards, online status, reports, blocks | consent (`sharing`); per-kind audience settings | other users the person chooses | until deleted | EXIF stripped; private by default for sleep, heart and body data |
| 7 | AI summaries (opt-in) | computed statistics, or one workout or measure in detail; no name, username or Strava data | explicit consent (`ai`) with each kind allowed | OpenCode (USA **[unsure]**) and the model provider (USA/EU/China **[unsure]**; zero-retention, no-training models only), or the user's own AI provider | provider keeps nothing per its terms; the chat stays in the account until Clear | only allowed kinds are sent; TLS |
| 8 | Notifications | push address, notification text (may include health numbers unless "Hide health numbers" is on) | consent | Firebase Cloud Messaging / Google (USA); browser push services (end-to-end encrypted) | until the device is removed | web push encrypted |
| 9 | Delivering the service | all traffic, including health data, in transit; IP address | needed to provide the service | Cloudflare (USA, global edge) | not stored by rep. | TLS and an encrypted tunnel |
| 10 | Security and abuse | request and error logs with IP and browser; reports | legitimate interest / legal duty | none | a few days **[set it, see gaps]** | access limited to the operator |
| 11 | Backups | copy of everything above | security of processing | none; both machines in Egypt | 7 days on the server, 30 days on the NAS | AES-256 encrypted archives, integrity check |
| 12 | Lookups | food search text or barcode; position rounded to about 1 km; song names | consent (feature use) | Open Food Facts (France), Open-Meteo (Switzerland/EU), Nominatim (EU), music services | not stored | no identity sent |
| 13 | Requests and support | email, username, message | performing the service; legal duty | email provider **[fill in]** | 1 year after closing **[decide]** | |

Data subject rights: export (JSON/CSV), correction in the app, deletion in the app or by email, and
withdrawing any consent in the app. The answer time is 30 days.
Profiling or automated decisions with legal effect: none. Direct marketing: none. CCTV: none.
Sale of data: none.

## Draft: cross-border transfer justification

> rep. is a fitness and health tracker run by one person in Egypt and stored on a server in Egypt.
> Personal data leaves Egypt in four ways. All are limited to what the feature needs, and each one
> except service delivery happens only after the user turns it on.
> (1) Connected services the user chooses: Google Health API, Strava, Hevy, Garmin and Xiaomi. The
> user's own account at that service sends data to rep. and, on request, receives it back. The user
> connects and disconnects each one, and disconnecting revokes access. These services already hold
> the data under their own terms.
> (2) Delivery: Cloudflare carries encrypted connections between the user and the Egyptian server.
> Firebase Cloud Messaging delivers notifications, and a setting keeps health numbers out of them.
> (3) Optional AI summaries through OpenCode. Only computed statistics of the kinds the user allows
> are sent, never the name, username or Strava data. Only models whose providers keep nothing and
> do not train on it are used.
> (4) Lookups that carry no identity (food, weather at about 1 km, music).
> The recipients are large providers with published security programmes (ISO 27001 / SOC 2) and
> data processing terms. Data is encrypted in transit, credentials are encrypted at rest, and the
> master copy and all backups stay in Egypt. Users are told about each transfer in the privacy
> policy and asked for explicit consent before health data is read. The risk to the user is low,
> because the user controls each flow and can stop it at any time.

**[unsure]** The recipient countries and certifications above. Check each provider's current DPA.

## Penalties and enforcement

The penalties are criminal fines, imposed by the Economic Courts on a prosecution. Ranges from the
law, as reported by SOG (secondary; check the Arabic text):

- Processing without consent: EGP 100k to 1M (Art. 36).
- Refusing a person's rights: EGP 100k to 1M (Art. 37).
- Breaching controller duties: EGP 300k to 3M (Art. 38).
- Sensitive data without consent: 3 months or more in prison and/or EGP 500k to 5M (Art. 41).
- Licence or permit violations: EGP 500k to 5M (Art. 45).
- Penalties double for a repeat offence.

No PDPC enforcement decision had been published as of October 2026. The reported plan is to start
with large data holders.

## Sources

- PDPC portal and its published page text: https://pdpc.gov.eg (register-start, login, services/liberal-profession, guidelines)
- Baker McKenzie, Jan 2026: https://www.bakermckenzie.com/-/media/files/insight/publications/2026/01/egypt_important-data-protection-update.pdf
- Baker McKenzie, Oct 2026 (portal launch, Digital Egypt): https://www.bakermckenzie.com/en/insight/publications/2026/10/egypt-personal-data-protection-law-update
- MENA Associates / Amereller, 28 Apr 2026: https://amereller.com/publication/the-egyptian-personal-data-protection-regime-what-you-need-to-know-ahead-of-31-october-2026/
- CMS: https://cms.law/en/are/legal-updates/egypt-s-pdpl-executive-regulations-issued-one-year-compliance-countdown-begins
- Chambers: https://chambers.com/articles/a-first-look-at-egypt-s-personal-data-protection-executive-regulations
- SOG checklist (fees, penalties; secondary): https://sog.eg/en/blog/egypt-pdpl-website-compliance-checklist
- Kooch portal guide (permit vs licence, fee exemptions; secondary): https://kooch.co/en/post/egypt-pdpl-licensing-portal-october-2026
- dataprotection.gi (enforcement status): https://dataprotection.gi/jurisdictions/egypt/

## Can it be skipped? (12 Nov 2026)

**Verdict: no lawful way to skip the permit while rep. works as it does now.** The least-effort lawful
path is the free liberal-profession permit, applied for now. Checked against the Andersen English
translation of the law and Decree 816/2025 (unofficial; the Arabic text governs).

Why each escape route fails:

- **Exclusions (law Art. 3).** The only ones are: personal use only, *official* statistics or a legal
  duty, journalism, court records, national security, and the Central Bank. Holding friends' data for
  them is a service, not personal use. ER Art. 19 (non-profit statistics) only widens what a licensed
  controller may do.
- **No size, free or non-business threshold.** The record counts (25,000 for permits, 100,000 for
  licences) set the fee only. Art. 4 lists "obtain a license or permit" as a duty, and ER Art. 2 says
  the collecting entity "shall be licensed or authorized". The controller definition says "by virtue
  or nature of their work", so one could argue a hobby is not work. But Art. 12 bans sensitive data
  without a licence for any controller, "whether a natural or legal person", and Art. 41 reaches any
  "data holder". Do not rely on that argument.
- **Consent, anonymisation.** Art. 12 requires the licence *and* written, explicit consent. Anonymised
  data is out of scope, but rep.'s accounts and social features make its data identifiable.
- **Users or server abroad.** Issuance Art. 2 covers an Egyptian national "inside or outside" Egypt,
  wherever the users are. A server abroad only adds a cross-border transfer (Arts. 14-16 and 42).
- **A foreign company as controller.** The law still covers foreigners abroad when the data subjects
  are Egyptians or residents (issuance Art. 2). The company would need an approved representative in
  Egypt (ER Art. 3), and the owner, running the server, would be a processor who needs a permit (Art. 5).
- **Deferral.** The grace period (issuance Art. 6) ended on 31 Oct or 1 Nov 2026. No extension,
  "register now, comply later" route or free notification had been announced. The fee-free permit
  under 25,000 records is the low-risk route.

The only true exits change the product. One is local-first: health data never leaves the device and
the server holds no accounts. The other is shutting rep. down, or keeping it for the owner's own data
only. The shared ojee.net login (mtg/dnd) is personal data too, so a permit is needed anyway. One permit
can probably list all three sites **[unsure]**.

Least-effort path (corrections to the steps above):

- ER Art. 38: the permit lasts up to 1 year, and "the permit holder ... shall act as the Personal
  Data Protection Officer". So no separate DPO is needed, which settles step 9.
- ER Art. 37 lists the documents. The ROPA covers most of them, and security certificates are needed
  only if you have them.
- The PDPC has 90 days from a complete file, and **silence counts as refusal** (ER Art. 38). File
  early and follow up. The PDPC approves the consent mechanism (ER Art. 2), so fix the consent gaps
  above first. No source says whether processing may continue while an application is pending **[unsure]**.

Enforcement risk if rep. waits:

- **Penalties.** No permit costs EGP 500k to 5M (Art. 45). Sensitive data or transfers outside
  authorised cases carry 3 months+ prison and/or EGP 500k to 5M (Arts. 41, 42). The judgment is
  published (Art. 48). Settling before a case costs half the minimum fine, EGP 250k for Art. 45 (Art. 49).
- **PDPC stance.** The acting CEO, Suzanne El Akabaoui (April 2026), said the PDPC will help with
  compliance before auditing, and will act on breaches and grounded complaints. No enforcement
  decision has been published.
- **Odds.** For a friends-only app the chance of action is low. The trigger would be a breach you must
  report, or a complaint. Low odds but severe criminal penalties favour filing the free permit now.

Sources: https://eg.andersen.com/wp-content/uploads/2026/02/Law-No.-151-of-2020.pdf (law, issuance
articles and ER); https://en.amwalalghad.com/?p=226843 (PDPC stance, 15 Apr 2026); dataprotection.gi
and CMS above (no extension). Not legal advice. A lawyer can confirm the "nature of work" point and
processing while pending.
