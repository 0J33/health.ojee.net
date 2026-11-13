# Public release: what is still missing

Brought up to date on 12 November 2026 (rep. 3.0.1, build 18 on Play's internal and closed
tracks; the website deployed the same day as v289). Only what is **left** is listed, numbered as in
the list gone through on 12 November: **blockers** stop a full public release; the rest is
**optional**. Each item says what was done and what is yours.

## Done in the app (for reference, not to do)

Signup box (16+, Terms and Privacy, kept with its time) · one-time "Before you start" sheet for
everyone · AI off until turned on, reading only the kinds of data the person allows, never their
name, never Strava, and only models whose providers keep nothing and train on nothing (OpenCode's zero-retention free models for everyone; the box's OpenCode Go subscription only with AI_SHARED_GO=1, its sign-in at ~/.local/share/opencode/auth.json; anyone can bring their own Go or Zen key in Settings) ·
Report and Block with an admin queue · Strava's data shown to its owner only, kept out of the
API, MCP and AI, removed when Strava is disconnected or its access is taken back, and sent to Google
Health only when the person turns that on · video and photo metadata removed · account deletion
gives Strava its grant back · full export · "Hide health numbers" for notifications · Labs switch
for Xiaomi and Garmin · OpenFreeMap basemaps, and now map tiles drawn on our own server for devices
without WebGL · privacy policy, terms and guidelines reviewed on 12 November (see 18) · incident plan
(`docs/INCIDENT.md`) · encrypted backups.

---

## Blockers for a full public release

### Google Play Console

1. [ ] **Closed test: 12 testers for 14 days**, then apply for production. *Yours, under way.*
2. [x] **Data safety form**: sent through the Play API on 12 Nov and checked by exporting it back.
   Changes from the old answers:
   - added User IDs, Email (only when Google is connected), User-generated content, and Device IDs (the push token);
   - health and fitness data are marked "not ephemeral", and "shared" for the optional AI summaries.
3. [x] **Account deletion URL**: `https://rep.ojee.net/privacy#delete`.
4. [ ] **Target audience and content**: **change to 18 and over only** (untick 16–17). The app became 18+ on 12 Nov because Egypt's PDPL treats under-18s as children whose health data needs a guardian's consent. IARC already lists "Users Interact" and "Shares Location". *Yours, in Play Console → App content → Target audience.*
5. [x] **Health apps declaration**.
6. [x] **Store listing** line "Not a medical device".

### Outside approvals

7. [ ] **Google OAuth verification**. See `docs/GOOGLE-VERIFICATION.md`.
   - Done: the branding (name "rep.", the current logo, rep.ojee.net links); the home page in plain HTML; the AI change that lets the Limited Use statement stand; the justification texts; the video script.
   - Done 12 Nov: branding verified and published; scopes trimmed to the 14 the code uses; features and justifications saved.
   - *Yours:* record the demo video, put its YouTube link in Data Access, and submit in Verification Center. Then the **CASA assessment**, which is required because the Google Health scopes are restricted (a few hundred USD, yearly).
8. [ ] **Strava athlete limit**. Done 12 Nov: the app was upgraded to **10 athletes**, and its rate limits doubled to 400 per 15 min and 4,000 a day. Its name is now "rep." and its website https://rep.ojee.net, with a description of how Strava data is used. The callback domain stays health.ojee.net, which the server's `STRAVA_REDIRECT_URI` and webhook use.
   - Past 10, Strava has to review the app, and its form refuses apps with fewer than 10 connected athletes. Once 10 people have connected, apply at https://share.hsforms.com/1VXSwPUYqSH6IxK0y51FjHwcnkd8 with the draft in "Strava application" below.
   - Strava's account page shows a subscription preview with 16 days left. The API's Standard tier needs a Strava subscription, so keep one when the preview ends.
   - Already fixed so they won't reject it: forwarding to Google Health is opt-in, Strava data stays out of the API, MCP and AI, the data is removed on disconnect, and the official button and "View on Strava" links are in.
9. [ ] **Egypt PDPL**. **Not pursued, by the owner's decision (12 Nov 2026).** The research and the filing path stay in `docs/PDPL.md` in case it is needed later. See `docs/PDPL.md` (12 Nov): as an individual you apply for a 12-month **permit** (not a company licence) on pdpc.gov.eg, likely free under 25,000 people. You need a Digital Egypt identity, a tax registration as a liberal profession, an e-signature token and a criminal record certificate; the record of processing and the transfer justification are drafted there. Earlier notes: Licensing is open: the executive regulations took force in Nov 2025, the grace period ended 31 Oct 2026, and the PDPC portal has been open since Oct 2026. Health data needs a sensitive-data licence, and transfers abroad (Google, Strava, AI providers) a cross-border licence. A licensed DPO must be registered first. Filing is through Digital Egypt. The portal is built for "organizations", and no source confirms an individual can file, so a local lawyer should say whether a company is needed first. Controllers under 100,000 records reportedly pay no licence fee. *Yours.*

### iPhone (App Store)

10. [x] **Apple Developer Program**: active since 13 Nov (team Omar Gamal, RWZP33F6KV). Done: the App IDs `net.ojee.health` (HealthKit, Push) and `net.ojee.health.widget`; the app in App Store Connect (Apple ID 6834149407, named "rep. by ojee" because "rep." was taken; the home screen still says "rep."); the App Store Connect API key `rep-asc` (Admin) in Codemagic; the APNs key (VZY4NY394Y, sandbox and production). The keys are in `~/.config/ojee-health-ios/` on LOQ and HP, never in a repo. *Yours, once disinteg is back:* copy the APNs key to the server and add `APNS_KEY_FILE`, `APNS_KEY_ID=VZY4NY394Y`, `APNS_TEAM_ID=RWZP33F6KV` to its `.env`.
11. [x] **HealthKit** (code). The iPhone app reads Apple Health through the same plugin and code as Health Connect on Android (`web/js/hc.js`). It shows as Me → Connections → Devices → Apple Watch, and on iPhone the "other watches" page uses Apple Health too. It is read only: the plugin cannot write workouts. Also added: the entitlement and the `NSHealthShareUsageDescription` and `NSHealthUpdateUsageDescription` strings. It turns on in builds whose user agent says `healthkit` (the App Store build); sideloaded builds stay as they were.
12. [x] **Push notifications** (code). Sent straight through Apple's push service (`server/apns.js`), with no Firebase on the phone. Done: the `aps-environment` entitlement, the AppDelegate token hand-off, and iPhone devices beside Android ones. *Yours:* the APNs `.p8` key, and `APNS_KEY_FILE`, `APNS_KEY_ID` and `APNS_TEAM_ID` in the server's `.env`.
13. [x] **Privacy manifest**: `ios/App/App/PrivacyInfo.xcprivacy`, plus the widget's. The App Privacy labels, matching the Play form, are in LISTING.md.
14. [x] **App Store Connect listing**: every field, the keywords, the age rating answers, and 12 screenshots (iPhone 6.9″ and iPad 13″), in `ojee-health-app/store/appstore/`. *Yours:* paste them in.
15. [x] **App Review notes**: in LISTING.md.
16. [x] **TestFlight**. Codemagic workflow `ios-appstore` signs, uploads and sends the build to TestFlight. Build 3.0 (1) is live for the internal group "Me" and was sent to Apple's beta review on 13 Nov for the external group "Testers". Listing, age rating (18+), screenshots, App Privacy, and both review contact and demo sign-in are filled in. *Yours:* add friends to "Testers" once the beta review passes.

---

## Optional

17. [x] **Encryption at rest** (12 Nov).
    - `~/health-server/data` is a LUKS2 volume, `/home/health-vault.img` (4 GB). It is mounted through `/etc/crypttab` and `/etc/fstab`, and unlocked at boot by the box's TPM (PCR 7, SHA1 bank: this TPM has no SHA256 one).
    - The old plain copy was shredded. The recovery passphrase is in the owner's password manager.
    - Backups are encrypted with `~/.config/rep-backup.key` (a copy is on the laptop).
    - Not yet tested: a reboot. Test one at a quiet time.
18. [x] **Legal review**. Privacy policy and terms were reviewed with Anthropic's legal skills (compliance check, risk assessment, contract review) and corrected against the code on 12 Nov. Open points for you are under "Decisions" below.
19. [x] **Hevy**: nothing in Hevy's API docs or terms forbids it. Their only ask is not to sync exactly on the hour.
20. [x] **Strava brand**: "View on Strava" in Strava orange and bold on every link back, the official "Connect with Strava" button, and the "Powered by Strava" logo on the From Strava card.
21. [x] **AI models that do not train**. Both AI paths now block every model OpenCode lists as keeping or training on data: big-pickle, MiMo Flash Free, Nemotron, the contributor models and beam-free. Nothing is sent to them even when they are the only free ones. The privacy policy says so.
22. [x] **Garmin**: kept in Labs. The program's Starter tier is for businesses and needs approval, the Personal tier covers only your own data, and Enterprise is paid. The free Starter application is worth sending if a company exists one day.
23. [x] **Trademark search**:
    - "REP" as a word is crowded and risky. Rep Fitness LLC holds REP in fitness equipment (US classes 28, 21, 25, 18, with more pending), and fitness-app marks such as REP TRACK, REP KING and REP WARRIOR are pending. Others hold REP in classes 9 and 42 for unrelated software.
    - The plate as a figurative mark is the safer filing.
    - WIPO, EUIPO and Egypt need a manual search (branddb.wipo.int, tmview).
24. [ ] **Company and insurance**: not now. It may be needed for PDPL (9) and Garmin (22).
25. [ ] **Licences page facts**: not now.
26. [x] **Raster fallback map**: drawn on our own server now (`server/raster.js`, `RASTER_RENDER=1`) from OpenFreeMap in the app's colours, and redrawn weekly. OpenStreetMap's tiles are used only if drawing fails.
27. [ ] **EU / UK**: not offered there.
28. [ ] **United States**: not offered there.
29. [ ] **At scale**: CSAM matching, a second moderator, WCAG 2.1 AA: later.

## Decisions for you (from the legal review)

- Done 12 Nov: new accounts **choose public or private** in the "Before you start" sheet (nothing assumed), and the app is **18+**.
- **Log retention**: no explicit limit is set for the server logs. Set one, then name it in the policy.
- **Inactive accounts** are kept forever. Consider deleting them after 2 years without a sign-in, with a warning first.
- **Deleting health data also clears blocks**, so a blocked person could find the account again.
- **Reports**: Apple usually expects a report acted on within 24 hours. The pages say 48.

## Strava application (draft, for item 8)

- **Company:** individual developer, Egypt.
- **App:** rep.
- **Support URL:** https://rep.ojee.net.
- **Description:**

> rep. (https://rep.ojee.net, web plus Android and iOS apps) is a personal health and training log. Each person connects their own Strava account with OAuth (read, activity:read_all, activity:write). We read their last 90 days of activities, then follow changes through the webhook, well inside the rate limits. Each activity's distance, pace, heart rate and route is shown only to that athlete, on their own workout page, with a "View on Strava" link back. Strava data is never shown to friends, never used in posts, feeds or leaderboards, never available through our API, and never sent to any AI model. Only if the athlete turns it on is their own activity also saved to their own Google Health. If they opt in, a workout they log in rep. (not one from Strava) is created on their Strava. Disconnecting, deauthorising on Strava, or deleting the account removes the Strava data we hold. Tokens are encrypted at rest. No data is sold or used for ads.

- **Screenshots to attach:**
  - the Strava connection page, before and after connecting;
  - the "What comes from Strava" sheet;
  - a workout's "From Strava" card;
  - the AI consent sheet.

## Live copy on HP

`deploy/replicate.sh` runs on disinteg under pm2 (`rep-replica`) and copies rep. to `HP:~/rep-replica/` about every 40 s: every database as a consistent snapshot, every other data file, the code with its `.env`, and the notification keys. It uses its own key, which HP only lets write into `~/rep-replica` (rrsync). It skips while the encrypted volume is not mounted, and stops while `HP:~/rep-replica/ACTIVE` exists.

If disinteg goes down, run rep. from the copy on HP with `bash ~/rep-replica/app/deploy/failover-hp.sh start`, then use `status` or `stop`. When disinteg is back, use `failback`: it prints how to hand HP's newer data back before the copying resumes.

Not done yet: public traffic to HP. HP has no Cloudflare tunnel. The fix is to run `cloudflared tunnel login` on HP once, create a `rep-standby` tunnel, and have the edge Worker (deploy/edge) prefer the standby while it is ACTIVE.
