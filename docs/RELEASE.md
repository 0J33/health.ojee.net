# Public release: what has to happen first

Written 31 October 2026, before any public release, from how the app is built
on that date. Health data, cycle data and photos together make this a
high-risk app: have a privacy lawyer review the result before launch. Items
marked **(check)** depend on rules that change; confirm the current version.

Tick items off as they are done (`- [x]`).

---

## 0. Blockers: the app breaks these rules today

- [ ] **Xiaomi scale login**: it uses an unofficial, reverse-engineered Xiaomi cloud login that holds the person's Xiaomi session. Against Xiaomi's terms and the stores' rules on third-party credentials. Remove it from the public app.
- [ ] **Garmin**: the connection uses each person's Garmin personal API key, meant for personal, non-commercial use **(check)**. Apply to the Garmin Connect Developer Program (Health/Activity API): application, approval, agreement, attribution rules.
- [ ] **Strava** **(check the current API agreement, tightened in 2024)**:
  - [ ] a person's Strava data may be shown only to that person: keep Strava activities out of the feed, boards and posts;
  - [ ] keep Strava data away from the AI;
  - [ ] apply for approval (new apps are limited to one athlete until approved);
  - [ ] "Powered by Strava" brand rules.
- [ ] **Hevy**: the API needs Hevy Pro and has its own terms. Check that commercial third-party use and showing Hevy sessions to other people are allowed.
- [ ] **Google Health API** (sleep, heart, ECG and reproductive data are sensitive or restricted scopes):
  - [ ] Google OAuth app verification;
  - [ ] most likely a yearly CASA security assessment (paid, by an approved lab);
  - [ ] full compliance with the Google API Services User Data Policy and its **Limited Use** rules: no advertising use, no human reading without consent, no transfer except to provide user-facing features;
  - [ ] showing Google data to friends and sending it to the AI disclosed and opted into;
  - [ ] **(check)** whether the Google Health API is open to public apps yet.
- [ ] **Map tiles**: OpenStreetMap's tile usage policy forbids heavy app use. Move to a commercial or self-hosted provider (MapTiler, Stadia, Protomaps); keep "© OpenStreetMap contributors".
- [ ] **AI** (every request sends health data to an outside provider, today OpenCode/Zen and the models behind it):
  - [ ] a separate, explicit opt-in;
  - [ ] a data processing agreement with the provider and a written no-training commitment;
  - [ ] a named list of subprocessors and their countries;
  - [ ] EU: Standard Contractual Clauses;
  - [ ] Apple guideline 5.1.2(i) (2025): clear disclosure and permission before personal data goes to third-party AI.
- [ ] **Hosting**: production runs on a home server (disinteg). Move to a professional host with a data processing agreement, encryption at rest, backups and access logging, in a chosen region (EU makes GDPR simplest), with no admin access over a personal Tailscale or home network.

## 1. Name, company and accounts

- [ ] **Name**: choose it, then official trademark searches in USPTO, EUIPO, WIPO Global Brand Database and Egypt, then file in the main markets; register the domain and social handles.
- [ ] **Company** (LLC/Ltd) so personal liability is limited.
- [ ] **Insurance**: cyber/privacy liability, and professional (E&O).
- [ ] **Apple Developer Program** as an organisation (needs a D-U-N-S number).
- [ ] **Google Play** as an organisation (a new personal account must first run a closed test with at least 12 testers for 14 days).
- [ ] **EU Digital Services Act**: declare trader status in both stores; publish a single point of contact. With the feed, comments and photos the app is a hosting service: notice-and-action, statements of reasons for removals, a basic transparency report.
- [ ] **Representatives**: an EU representative (GDPR Art. 27), and a UK one, if there is no office there.
- [ ] **Data protection officer**: may be required for health data at scale; get advice.

After a rename: new bundle ID / package name (today `net.ojee.health`), new store listing, screenshots without real people's data.

## 2. Privacy law (health data is a special category everywhere)

### Everywhere

- [ ] **Privacy policy**, rewritten for the public (today's `web/privacy.html` is written for friends). It names:
  - the controller (company, address, contact, representatives);
  - every data category: health metrics, sleep, ECG, reproductive and cycle data, mood, stress, symptoms, food, weight, GPS routes, photos and videos, social data;
  - purpose and legal basis for each; retention periods;
  - every processor and third party: host, AI provider, Google, Garmin, Strava, Hevy, Open Food Facts, map tiles, push services (Apple and Google through Web Push);
  - international transfers; user rights and how to use them; breach handling; children; automated decisions (the AI summaries).
- [ ] **Consent design**: separate opt-ins for health processing, sharing with friends, AI, each connected service, reproductive data, location/routes, push notifications. Nothing pre-ticked; withdrawing as easy as giving; a record of what was consented to and when.
- [ ] **In-app account deletion** (both stores require it): every server row and media file, tokens revoked with Google, Garmin, Strava and Hevy; also from a web page (Play needs the URL); backups expire on a stated schedule.
- [ ] **Data export**: everything, JSON or CSV, photos and videos included.
- [ ] **Minimisation**: reproductive and cycle data off by default; consider keeping it on the phone only. Raw GPS kept only as long as needed (the 200 m trimmed off each end of shared routes is good: document it).
- [ ] **Retention schedule**: logs, AI request logs, inactive accounts, deleted posts.
- [ ] **Security**: health data encrypted at rest (today the SQLite files are plain on disk; only the OpenCode key is encrypted); TLS everywhere; ideally two-factor sign-in; rate limits (present); dependency patching; a penetration test; secrets management; an admin access audit; a written incident-response and breach-notification plan.
- [ ] **Analytics**: none today. If added: consent, and Apple's App Tracking Transparency.

### EU and UK (GDPR / UK GDPR)

- [ ] Explicit consent for health data (Art. 9).
- [ ] DPIA, record of processing activities, data processing agreements with every processor, transfer impact assessments plus SCCs for US providers.
- [ ] Breach notification to the regulator within 72 hours.
- [ ] Age: consent age is 13-16 by country. Simplest: 18+, or 16+ with an age check.
- [ ] Cookies (ePrivacy): only the session cookie and localStorage, strictly necessary. Keep it that way and say so.

### United States

- [ ] HIPAA usually does not apply (not a provider or insurer). Don't market to clinics.
- [ ] FTC Health Breach Notification Rule (amended 2024): unauthorised disclosure is a breach; notify users and the FTC.
- [ ] FTC Act Section 5: privacy promises must match what happens.
- [ ] Washington My Health My Data Act (and Nevada, Connecticut): separate consent to collect and to share consumer health data; a separate Consumer Health Data Privacy Policy linked from the home page; signed authorisation before any sale; no geofencing near health facilities; private right to sue (Washington).
- [ ] CCPA/CPRA and other state laws: thresholds probably not met, but honour the sensitive-data rules and "limit use" right.
- [ ] COPPA: block under-13s (age gate, terms, store rating).

### Other countries (check each launch country)

- [ ] **Egypt**: Personal Data Protection Law 151/2020. Health data is sensitive; processing needs a licence or permit from the Personal Data Protection Center; cross-border transfers restricted.
- [ ] Saudi Arabia PDPL (transfer and registration), UAE PDPL.
- [ ] India DPDP Act 2023, Brazil LGPD, Japan APPI, South Korea PIPA (strict consent and transfers), Australia Privacy Act.
- [ ] Canada PIPEDA; Quebec Law 25 (privacy officer, impact assessments, explicit consent).
- [ ] China PIPL: don't distribute there.
- Or: release only in the countries reviewed.

## 3. Medical and health claims

- [ ] Describe and market the app as general wellness only: nothing that diagnoses, treats or prevents.
- [ ] Review the features that sound clinical: the illness / "Your body looks under strain" flag; ECG readings; irregular rhythm notifications; readiness, resilience and sleep scores; glucose and body temperature; AI advice ("train hard", "rest").
- [ ] ECG or claims about arrhythmia or illness can make the app a medical device (EU MDR Rule 11, FDA, UK MHRA). Remove or soften them, or show only the user's cleared device's own readings with no interpretation.
- [ ] Disclaimers at first launch, in the terms and in the store listing: not a medical device and not medical advice; see a doctor about symptoms; in an emergency call local emergency services; scores are estimates and may differ from Google's or Garmin's; AI output can be wrong (already shown); exercise at your own risk.
- [ ] Don't present the scores as Google's or Fitbit's ("our estimate", never "Fitbit Readiness").

## 4. Social features, user content, photos and videos

- [ ] Apple guideline 1.2 and Play's user-generated content policy: a filter for objectionable content; report posts, comments, photos and users; **block users** (today friends can be removed, not blocked); act on reports within 24 hours; published contact details; accept the terms before posting.
- [ ] Terms: who owns uploads and the licence needed to host and show them; forbidden content; removal rights; repeat-infringer policy.
- [ ] Copyright: register a DMCA agent with the US Copyright Office; notice-and-takedown (DMCA, and DSA Art. 16).
- [ ] Child sexual abuse material: duty to report to NCMEC (US); consider hash-matching uploads (PhotoDNA or similar).
- [ ] Strip metadata from **videos** (photos are already re-drawn in the browser, which removes EXIF and GPS; video bytes are stored as uploaded).
- [ ] Defaults: friends-only posts (as now); make clear that boards show your stats to friends or to Everyone.
- [ ] A minimum age (16+ or 18+), enforced.

## 5. Apple App Store

- [ ] **Minimum functionality (4.2)**: a mostly-WebView app risks rejection. Native Bluetooth heart rate helps; plan more: HealthKit sync, widgets, native notifications, offline use.
- [ ] App Privacy labels for every data type (health, fitness, location, photos, social, identifiers, usage) and whether each is linked to the person.
- [ ] Privacy manifest (`PrivacyInfo.xcprivacy`): required-reason APIs, tracking domains; check Capacitor and plugin manifests.
- [ ] Health data (5.1.3): no advertising or data-broker use. With HealthKit: no iCloud storage of its data, the entitlement and usage text.
- [ ] Usage descriptions: Bluetooth, camera, photo library, location; justify background Bluetooth in review notes.
- [ ] In-app account deletion (5.1.1(v)); a demo account and review notes.
- [ ] Sign in with Apple only if Google or other social sign-in is added (connecting Google for data does not trigger it).
- [ ] Age rating: the 2025 questions (user content, health topics).
- [ ] Export compliance: `ITSAppUsesNonExemptEncryption = NO` if only standard HTTPS.
- [ ] AI: disclosure, consent (5.1.2(i)), filtered output.
- [ ] Distribution through TestFlight and the App Store (not SideStore). EU alternative marketplaces still need Apple notarisation.

## 6. Google Play

- [ ] Health apps declaration; Health Connect declaration if moving to Health Connect (the expected Android route; Play looks hard at cloud-only health apps).
- [ ] Data safety form matching the privacy policy exactly (encryption in transit, deletion link, every data type).
- [ ] Privacy policy URL and account-deletion URL.
- [ ] Target API level: keep up with the yearly requirement (36 today; check each August).
- [ ] Permissions: Bluetooth with `neverForLocation` (done); purpose text for camera and location; a declaration and demo video if background location or a foreground service for live heart rate is added; the Android photo picker, not READ_MEDIA permissions.
- [ ] User-generated content policy (section 4); target audience and content questionnaire; IARC rating.
- [ ] Release as an Android App Bundle (AAB) with Play App Signing. The current release key (`~/.config/ojee-health-android/release.jks`) can become the upload key: keep it safe.
- [ ] Closed test (12 testers, 14 days) if the account is personal.

## 7. Desktop and web

- [ ] The live website is already under these laws: the privacy policy, terms, consent and storage statement apply to it too.
- [ ] Microsoft Store via PWABuilder: its age rating and privacy rules. Mac App Store: the iOS review; outside the store, code signing and notarisation.
- [ ] Web push: no sensitive health detail on the lock screen (or make it a setting).
- [ ] Accessibility: aim for WCAG 2.1 AA (US ADA risk); **(check)** whether the European Accessibility Act (since June 2025) covers the app.

## 8. Licences and attribution: an in-app "Open-source licences" page

- [ ] Fonts: Instrument Sans and Newsreader (SIL Open Font License), with the licence text.
- [ ] Icons: Lucide (ISC).
- [ ] Exercise library: free-exercise-db (public domain, Unlicense): credit it; check its photos carry no third-party rights.
- [ ] Food: Open Food Facts: ODbL database (attribution, share-alike), CC BY-SA images, a custom User-Agent, rate limits.
- [ ] Maps: OpenStreetMap data (ODbL), visible credit (shown), plus the new tile provider's terms.
- [ ] Software: Capacitor and plugins (MIT), Capacitor community Bluetooth LE, web-push, the MongoDB driver and the rest: generate a third-party notices file from `package.json` in both repos (this one and ojee-health-app).
- [ ] Brands: Google, Fitbit, Garmin, Strava, Hevy names and logos only as their guidelines allow ("Works with…", no implied endorsement); "Powered by Strava"; Garmin's attribution rules.

## 9. Documents to write or update

- [ ] Privacy policy (public), plus a Consumer Health Data Privacy Policy (Washington).
- [ ] Terms of service: eligibility and age; accounts; user content licence and rules; wellness disclaimer and assumption of risk; AI disclaimer; third-party services; limitation of liability and indemnity; governing law and venue; EU/UK consumer-law carve-outs; termination; how changes are announced.
- [ ] Community guidelines; reporting and moderation policy.
- [ ] Copyright/DMCA policy; DSA contact point and transparency notice.
- [ ] Cookie and storage statement (session cookie and localStorage only).
- [ ] Public subprocessor list with change notice.
- [ ] Internal: DPIA and record of processing; data processing agreements; incident-response and breach plan; retention schedule; security policy and access control; CASA results; age-gate design; consent records.
- [ ] Disclaimers: store listings, first launch, AI screens, wherever ECG or "strain" appear.

## 10. Product changes this implies

- [ ] Onboarding: age check; terms and privacy acceptance; separate health / AI / sharing / reproductive consents, each recorded.
- [ ] Moderation: block user; report post, comment, photo, user; an admin moderation queue; automatic image screening.
- [ ] Account: in-app deletion with token revocation for every service; full export including photos and videos.
- [ ] Remove the Xiaomi login; keep Strava data out of shared places and the AI.
- [ ] Replace OpenStreetMap tiles (commercial or self-hosted) and Garmin personal keys (official program, once approved).
- [ ] Strip video metadata on upload.
- [ ] Encrypt health data at rest.
- [ ] Notifications without sensitive detail; no health values in server logs.
- [ ] New app identity after the rename (bundle ID, package name, store listing, screenshots with no real data).
