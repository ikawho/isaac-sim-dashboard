# Changelog

All notable changes to Isaac Sim Dashboard. Newest version first.

## v1.2 — 2026-11-23

Three new functions: the dashboard speaks **German and English**, every **Delete** button asks for a **second click** instead of a browser pop-up, and `./isaac.sh up` **repairs SAM's deleted upload bucket** by itself. They fix deleting inside OLAT and the "S3 Bucket does not exist" error. The dashboard also fits phone screens now.

### Added

- **German and English dashboard.**
  - German is the default. Two flag buttons (Germany, UK) at the top right of the sign-in page and of the dashboard switch the language right away, without reloading. The browser remembers the choice.
  - German texts address users formally ("Sie"). Dates, numbers and file sizes follow the chosen language, for example "20.11.26" and "1,2 MB" in German. The Admin tab is called **Verwaltung** in German.
  - Only the dashboard's own texts are translated. Status details and error messages from the server, the boot log, AWS error codes, emails and all CloudShell output stay in English.
  - New file `frontend/i18n.js` holds all texts of both languages.
- **Two-click delete instead of browser pop-ups.**
  - Applies to all four Delete buttons: a file in My files, your own machine, and in the Admin tab a user or a machine.
  - The first click turns the button red and changes it to **Löschen?** / **Delete?** (for your machine: **Bestätigen: Maschine löschen** / **Confirm: delete machine**). A short note at the bottom of the page says what will be deleted.
  - A second click within 5 seconds deletes. Without a second click the button goes back to normal and nothing is deleted.
  - The dashboard no longer opens any browser pop-up.
- **Automatic repair of SAM's upload bucket in `./isaac.sh up`.**
  - Before deploying, `up` checks whether SAM's upload bucket still exists. If it was deleted but SAM's helper stack `aws-sam-cli-managed-default` wasn't, `up` deletes that stale helper stack, and SAM creates a new bucket in the same run.
  - It only acts when the bucket is really gone. The Isaac Sim stack, users, files and machines are not touched.

### Changed

- README: new section "What's new in v1.2"; describes the language switch, the second click on every **Delete** button, what to expect when updating from v1.1, and the "S3 Bucket does not exist" error in the troubleshooting table.

### Fixed

- **Deleting didn't work inside OLAT.** OLAT's course frame suppresses browser pop-ups, so the delete confirmation never appeared and nothing was deleted. Fixed by the two-click delete above.
- **`./isaac.sh up` failed with "Unable to upload artifact … S3 Bucket does not exist"** when SAM's upload bucket had been deleted. Until now you had to delete the stack `aws-sam-cli-managed-default` by hand. Fixed by the automatic repair above.
- **The dashboard scrolled sideways on phones.** The machine card, My files and the Admin tables now fit the screen; wide tables scroll inside their own card.

### Upgrading from v1.1

Download `isaac-sim-dashboard.zip` from the v1.2 release, replace the old folder in CloudShell and run `./isaac.sh up`. Users, files and machines are kept, and nobody has to sign in again. Reload the dashboard (Ctrl+Shift+R) so the browser loads the new files; it then opens in German.

## v1.1 — 2026-11-20

The dashboard can now be embedded in a learning management system such as OLAT. Cognito's own sign-in pages refuse to load inside a frame (they send `X-Frame-Options: DENY`), so the dashboard now has its own sign-in form.

### Added

- **Own sign-in form in the dashboard.** It talks to Cognito through AWS's `amazon-cognito-identity-js` library (version 6.3.12, loaded from jsDelivr with a Subresource Integrity hash). It uses SRP, so the password is never sent, not even to Cognito. The form covers:
  - signing in with email and password;
  - choosing your own password at first sign-in, after signing in with the temporary password from the invite email;
  - **Forgot password?**: a code by email, then a new password;
  - the 6-digit authenticator code for accounts with MFA.
  
  Errors such as a wrong password, a password that is too weak or an expired code are shown in plain English next to the form.
- **Embedding in an LMS (OLAT).** The new setting `FRAME_ANCESTORS` (template parameter `AllowedFrameAncestors`) lists the sites that may show the dashboard in a frame, separated by spaces. The default is `https://olat.vcrp.de`; an empty value allows no other site.
- README section "Embedding the dashboard in an LMS (OLAT)".
- This changelog.

### Changed

- CloudFront uses its own response-headers policy instead of AWS's managed `SecurityHeadersPolicy`. It sends the same HSTS, `X-Content-Type-Options: nosniff` and `Referrer-Policy` headers as before, but `Content-Security-Policy: frame-ancestors 'self' <allowed sites>` instead of `X-Frame-Options: SAMEORIGIN`.
- The Cognito app client allows the SRP sign-in method (`ALLOW_USER_SRP_AUTH`).
- The Cognito user pool is set explicitly to the Lite tier. New user pools would otherwise default to the Essentials tier, which the dashboard doesn't need.
- `isaac.sh up` writes the user pool ID (`userPoolId`) into the dashboard's `config.js`.
- **Sign out** returns to the dashboard's sign-in form instead of going through Cognito's sign-out page.
- README: version 1.1, an upgrade note, and release steps that take the release notes from this changelog.

### Removed

- The redirect to Cognito's hosted sign-in pages (the OAuth authorization code flow with PKCE in `frontend/app.js`).

### Upgrading from v1.0

1. Download `isaac-sim-dashboard.zip` from the v1.1 release, replace the old folder in CloudShell and run `./isaac.sh up`. Users, files and machines are kept.
2. Everyone has to sign in once more; passwords stay the same.
3. If **Open Isaac Sim** doesn't open a new tab from inside OLAT, allow popups for the course element.

## v1.0 — 2026-11-19

First release.

- Web dashboard on AWS (SAM), installed and removed with `./isaac.sh up` / `./isaac.sh down` from AWS CloudShell.
- Each user starts their own GPU machine running NVIDIA Isaac Sim, streamed to the browser with NVIDIA's WebRTC web viewer.
- Sign-in with Amazon Cognito; administrators invite users by email.
- Private S3 file storage per user, synced into Isaac Sim's `/workspace` folder.
- Setup progress and boot log in the dashboard.
- Admin view: invite users, make admins, disable accounts, stop or delete any machine.
- Machines stop automatically after a configurable number of hours (default 8).
- GPU capacity search across several instance types and availability zones, shown in the dashboard.
