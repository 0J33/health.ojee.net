# Incident plan

What to do when personal data may have been seen, changed, lost or taken by someone
who should not have it (a leaked key or backup, a bug that showed one person's data
to another, a break-in on disinteg or the HP box, a lost laptop with credentials).
The operator (Omar Gamal) decides and acts; there is no one else to escalate to.

1. **Detect.** Signs: an error or report from a user, odd entries in `journalctl -u health`
   or nginx logs, a failed backup integrity check, a provider's security email (Google,
   Strava, Hevy, Garmin, Firebase), or GitHub secret scanning. Write down the time noticed.
2. **Contain, the same hour.** Stop the leak first: take the route or service down
   (`sudo systemctl stop health` on disinteg; killing the process alone is not enough,
   `Restart=on-failure` brings it back), rotate what may be exposed (`APP_SECRET`, OAuth client
   secrets, the Firebase key, the Play service-account key, SSH keys, the Mongo password),
   revoke sessions if accounts may be affected, and keep the logs and a copy of the affected
   databases for the investigation. Restore from `~/health-backups` only after the cause is fixed.
3. **Assess, within 24 hours.** Who is affected, which data (health data, cycle data and
   location are the serious ones), since when, and whether it was actually accessed. Keep
   notes as you go.
4. **Tell the people affected, within 72 hours** of becoming aware, and never later than 3 working days after telling the PDPC (step 5; PDPL 151/2020), in the app (a notice on
   Today) and by any contact they gave: what happened, what data, what was done, what they
   should do (change the password, revoke connections), and who to write to
   (contact@ojee.net). Plain words, no hedging.
5. **Tell regulators where required.** Egypt: the Personal Data Protection Center, within
   72 hours, through its portal (pdpc.gov.eg) or hotline (PDPL 151/2020). Do this first. US users: the FTC under the Health Breach Notification Rule
   (within 60 days; at once if 500+ people). EU/UK users, if the app is offered there: the
   lead supervisory authority within 72 hours. Also tell any connected service whose data
   or credentials were involved (Google, Strava, Hevy, Garmin).
6. **Fix and follow up.** Fix the cause, add a test that would have caught it, check the
   fix on production, and send a short follow-up to the people told in step 4.
7. **Log it.** Every incident, even a near miss, gets an entry below: date, what happened,
   who was affected, what was done, who was told and when.

## Log

| date | what happened | who was affected | what was done | told |
|---|---|---|---|---|
| | | | | |
