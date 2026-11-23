# Isaac Sim Dashboard v1.2

Isaac Sim Dashboard is a web page where each user signs in and starts their own cloud GPU machine running NVIDIA Isaac Sim with one click. Isaac Sim then runs in a browser tab, streamed from the machine. Use it when you need Isaac Sim but don't have a suitable NVIDIA RTX workstation, or when several people need their own Isaac Sim without sharing one computer. Every user gets private file storage that appears inside Isaac Sim, and administrators can invite users and see every machine. The whole setup lives in your own AWS account. You install it with one command and remove it with one command, both run from AWS CloudShell, a terminal in the browser that comes with every AWS account.

## What's new in v1.2

- **German and English.** The dashboard opens in German; the flags at the top right switch to English and back.
- **Two-click delete.** Every **Delete** button asks for a second click instead of a browser pop-up, so deleting works inside OLAT too.
- **Automatic repair of the "S3 Bucket does not exist" error.** `./isaac.sh up` recreates SAM's upload bucket when it was deleted.
- **Phone layout.** The dashboard no longer scrolls sideways on phones.

All changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Prerequisites

You need:

- **An AWS account where you can create resources.** An administrator account is the simplest; a restricted university or company account may block the install. You work in the [AWS Console](https://console.aws.amazon.com/) only.
- **GPU quota in your AWS region.** AWS limits how many GPU machines an account can run; new accounts often start at 0. In the console, open **Service Quotas → AWS services → Amazon EC2 → Running On-Demand G and VT instances**. Each running Isaac Sim machine needs 8 vCPUs, so request at least `8` for one user, or `32` for four users at once. Approval can take a few hours to a couple of days, so do this first.
- **An email address** for the first administrator account. The sign-in details are sent there.
- **Agreement to the NVIDIA Omniverse License Agreement.** The installer downloads NVIDIA's Isaac Sim container, and you accept the license by setting `ACCEPT_EULA=Y`.

You do **not** need to install anything on your own computer. CloudShell already includes the AWS CLI and the AWS SAM CLI (`sam`), the two tools the installer uses.

## Quickstart

**1. Open CloudShell in your region.** In the AWS Console, pick a region in the top-right corner. `eu-central-1` (Frankfurt) is the default here; any region with G-type GPU machines works. Then click the CloudShell icon (`>_`) in the top bar.

**2. Upload the project.** On the project's GitHub page, open **Releases**, pick the latest release, and download `isaac-sim-dashboard.zip` from its **Assets**. Don't use the "Source code" downloads; they unpack into a differently named folder. In CloudShell, use **Actions → Upload file** to upload the ZIP, then run:

```bash
cd ~ && unzip -o isaac-sim-dashboard.zip && cd isaac-sim-dashboard
```

**3. Install.** Replace the email address with your own:

```bash
ADMIN_EMAIL=your@email.com ACCEPT_EULA=Y ./isaac.sh up
```

The first install takes about 5–10 minutes. It ends with output like this:

```
==> Done. Dashboard: https://example.cloudfront.net/
==> The first admin (your@email.com) receives a temporary password by email.
```

**4. Sign in.** Open the dashboard URL and sign in with your email address and the temporary password from the email, which comes from `no-reply@verificationemail.com`. You must set a new password on first sign-in: at least 12 characters, with upper case, lower case and a number.

If the email doesn't arrive (university and company mail servers often filter this sender), set a password yourself in CloudShell:

4.1. Find the user pool ID:
```bash
aws cognito-idp list-user-pools --max-results 20 --region eu-central-1 \
--query "UserPools[?Name=='isaac-sim-dashboard-users'].Id" --output text
```

4.2. Check the account status:
```bash
aws cognito-idp admin-get-user --user-pool-id <POOL_ID> --username <ADMIN_EMAIL> \
--region eu-central-1 --query UserStatus
```

4.3. Set a permanent password (at least 12 characters, with upper case, lower case and a number):
```bash
aws cognito-idp admin-set-user-password --user-pool-id <POOL_ID> --username <ADMIN_EMAIL> \
--password '<your password>' --permanent --region eu-central-1
```

**5. Start Isaac Sim.** Click **Start machine**. The dashboard first searches for a free GPU machine; the **GPU capacity search** table shows every machine type and zone it tries. It then shows the setup steps. The first start takes 20–30 minutes, because the Isaac Sim container (about 20 GB) is downloaded and its shader cache is built. When the status shows **Ready**, click **Open Isaac Sim**. It opens in a new tab and needs a Chromium-based browser such as Chrome or Edge.

### Daily use

| Button | What it does | Cost while in this state |
|---|---|---|
| **Stop machine** | Shuts the machine down but keeps its disk, so the next start takes only a few minutes. | Disk storage only, about 20–25 USD per month |
| **Delete machine** | Removes the machine and its disk. Your files are kept. The next start is a full 20–30 minute first start again. Click twice: the first click turns the button red, the second deletes. | Nothing |
| **Allow my current IP** | The stream only works from the internet address you started the machine from. Click this after changing networks, for example to another Wi-Fi or a VPN. | – |

Files you upload under **My files** appear in Isaac Sim in the folder `/workspace`. What you save there is copied back every 2 minutes and when the machine stops. Running machines are stopped automatically after 8 hours, so a forgotten machine doesn't keep costing money.

Administrators see an extra **Admin** tab (**Verwaltung** in German), where they can invite users by email, make other users admins, disable accounts, and stop or delete any machine.

Every **Delete** button, for files, your machine and in the Admin tab, asks for a second click instead of opening a browser pop-up, because pop-ups don't appear when the dashboard is embedded in OLAT. If you don't click again within 5 seconds, nothing is deleted.

The dashboard is in German by default. Use the German and UK flags at the top right to switch between German and English; the browser remembers the choice. Only the dashboard itself is translated. Status details and error messages sent by the server, the boot log, emails and everything in CloudShell stay in English.

### Updating and removing

To update to a new version, first download `isaac-sim-dashboard.zip` from the latest release on GitHub. In CloudShell, remove the previous directory and the previous ZIP file:
```bash
cd ~ && rm -rf ~/isaac-sim-dashboard && rm isaac-sim-dashboard.zip
```

Upload the new ZIP file, unzip it and change into the directory:
```bash
cd ~ && unzip isaac-sim-dashboard.zip && cd isaac-sim-dashboard
```

Run the install command without variables. Existing users, files and machines are kept:
```bash
./isaac.sh up
```

When you update from v1.0, the dashboard gets its own sign-in form instead of Cognito's sign-in pages. After that update, everyone has to sign in once more; passwords stay the same.

When you update from v1.1, nobody has to sign in again. Reload the dashboard once (Ctrl+Shift+R) so the browser loads the new files; it then opens in German.

All changes are listed in [CHANGELOG.md](CHANGELOG.md).

Show the installation status and all machines:

```bash
./isaac.sh status
```

Remove **everything**, including all users, all machines and all stored files. You are asked to type `yes`:

```bash
./isaac.sh down
```

To stop a single machine, use **Stop machine** in the dashboard, not `down`.

## The three most important settings

Set these as variables in front of `./isaac.sh up`, on the first install or on any later update. A value you set is remembered: later runs of `./isaac.sh up` without it keep the last value. To go back to the default, set the default value explicitly.

### 1. `INSTANCE_TYPE` and `FALLBACK_INSTANCE_TYPES`: which GPU machine is used

`INSTANCE_TYPE` is the preferred GPU machine type; the default is `g6e.2xlarge` (NVIDIA L40S GPU, 8 vCPUs). If AWS has none free, the dashboard tries the `FALLBACK_INSTANCE_TYPES` in order, in every zone of the region. The default fallback list is `g6e.xlarge,g6.2xlarge,g5.2xlarge,g6.4xlarge,g5.4xlarge,g4dn.2xlarge`.

```bash
INSTANCE_TYPE=g6.2xlarge FALLBACK_INSTANCE_TYPES=g5.2xlarge,g6e.2xlarge ./isaac.sh up
```

Only G-family types (`g4dn`, `g5`, `g6`, `g6e`, `g7e`) are allowed, because streaming needs the NVIDIA video encoder those GPUs have. `g4dn` (an older T4 GPU) is the last resort: Isaac Sim is slow on it, or may not start at all. Set `FALLBACK_INSTANCE_TYPES=` (empty) to never use another type.

### 2. `MAX_SESSION_HOURS`: automatic stop

A running machine is stopped automatically after this many hours. The default is `8`, and the allowed range is 1–72. A GPU machine costs about 1–3 USD per hour while running, so this limit protects you from forgotten machines.

```bash
MAX_SESSION_HOURS=4 ./isaac.sh up
```

### 3. `AWS_REGION`: where everything runs

This sets the AWS region for the whole installation. By default it is the region CloudShell is open in, or `eu-central-1` if none is set. Pick a region close to your users, because the stream lag depends on the distance. The region needs G-type GPU machines and at least three availability zones. The GPU quota is set separately per region, so request it again there.

```bash
AWS_REGION=eu-west-1 ADMIN_EMAIL=your@email.com ACCEPT_EULA=Y ./isaac.sh up
```

To run a second, independent installation next to the first one, for example for testing, also give it its own `STACK_NAME`, such as `STACK_NAME=isaac-dev`. To use another Isaac Sim version, set `ISAAC_IMAGE`; the default is `nvcr.io/nvidia/isaac-sim:6.2.0`.

### Embedding the dashboard in an LMS (OLAT)

The dashboard can be shown inside a course page, for example as an OLAT "External page" element pointing to the dashboard URL. It has its own sign-in form for this, because Cognito's sign-in pages refuse to load inside a frame. Only the sites listed in `FRAME_ANCESTORS` may embed it; the default is `https://olat.vcrp.de`. Give several sites separated by spaces, or an empty value to forbid embedding:

```bash
FRAME_ANCESTORS="https://olat.vcrp.de https://lms.example.org" ./isaac.sh up
```

**Open Isaac Sim** always opens the stream in a new browser tab. If the LMS blocks new tabs from the frame, allow popups for the course element.

## When something goes wrong

| What you see | What to do |
|---|---|
| **S3 Bucket does not exist** during `./isaac.sh up` | SAM's upload bucket was deleted. Since v1.2, `./isaac.sh up` notices this and recreates it, so just run it again. With older versions, delete the stack `aws-sam-cli-managed-default` in the CloudFormation console first. |
| **Start failed – No GPU capacity available** | AWS has no free GPU machine of any listed type. Try again later, or use another region. |
| **Start failed – vCPU quota** | Request a higher GPU quota (see Prerequisites). |
| A setup step takes very long, or **Start failed** with "see boot log" | Open **Boot log** under the status. It shows the machine's setup output, updated every 15 seconds. The last lines usually show the error. |
| Isaac Sim tab opens but stays black | Click **Allow my current IP**, then reload the Isaac Sim tab. |

If the boot log isn't enough, you can open a terminal on the machine from CloudShell. SSH isn't needed. First list the IDs of the running machines, then connect to one:

```bash
aws ec2 describe-instances --filters "Name=tag:Project,Values=isaac-sim-dashboard" "Name=instance-state-name,Values=running" --query "Reservations[].Instances[].[InstanceId, Tags[?Key=='OwnerEmail'].Value|[0]]" --output text
aws ssm start-session --target i-0123456789abcdef0
sudo tail -100 /var/log/isaac-boot.log
sudo docker logs --tail 80 isim-isaac-sim-1
```

## Project structure

```
isaac-sim-dashboard/
├── isaac.sh            The only command you run: up | down | status
├── API.md              Reference for the HTTP API, for scripts and integrations
├── template.yaml       Describes everything AWS creates for the installation (network, login,
│                       storage, web hosting, API, GPU machine template). Deployed with AWS SAM.
├── src/                Server code runs on AWS Lambda (Python 3.12)
│   ├── instance.py     Start / stop / delete your own machine, boot log
│   ├── ec2ops.py       GPU machine logic: capacity search, fallbacks, firewall per user, status
│   ├── files.py        Your private file storage (upload/download links)
│   ├── admin.py        Admin tab: users and all machines
│   ├── autostop.py     Runs every 15 minutes, stops machines after MAX_SESSION_HOURS
│   ├── common.py       Shared helpers (login check, error responses)
│   └── userdata.sh     Setup script that runs on each GPU machine: installs Docker,
│                       downloads Isaac Sim, builds the web viewer, syncs your files
└── frontend/           The dashboard web page (plain HTML/CSS/JavaScript, no build step)
    ├── index.html
    ├── app.js
    └── styles.css
```

How the parts fit together: the dashboard page is served through CloudFront and calls an API. The API checks your login (Amazon Cognito) and runs the Python functions in `src/`. When you click **Start machine**, those functions create a GPU machine (Amazon EC2) from the AWS Deep Learning AMI and pass it `userdata.sh`. The machine runs Isaac Sim and NVIDIA's web viewer in Docker, and streams to your browser over WebRTC. Its firewall only lets in your own IP address. Your files are stored in Amazon S3. To call the API from your own scripts, see [API.md](API.md).

**Key dependencies:**
- **Tools**, preinstalled in CloudShell: AWS CLI v2, AWS SAM CLI.
- **AWS services:** CloudFormation, Lambda, API Gateway (HTTP API), Cognito, S3, CloudFront, EC2, Systems Manager, EventBridge.
- **On the GPU machine:**
  - AWS Deep Learning Base AMI (Ubuntu 22.04, NVIDIA driver)
  - Docker with the NVIDIA Container Toolkit
  - The NVIDIA Isaac Sim container `nvcr.io/nvidia/isaac-sim`
  - NVIDIA's WebRTC web viewer, built from the [isaac-sim/IsaacSim](https://github.com/isaac-sim/IsaacSim) repository

## Releasing a new version (maintainers)

Users install from the ZIP attached to a GitHub release, so every new version needs a tag and a release. Run this on a computer with `git` and the [GitHub CLI](https://cli.github.com/) (`gh`), signed in with `gh auth login`.

1. Add the changes under a new version heading in [CHANGELOG.md](CHANGELOG.md), then commit and push:
   ```bash
   git add -A && git commit -m "Describe the change" && git push
   ```
2. Pick the new version number and update the title of this README if it changed. Then tag the release, build the ZIP from the tag, and publish it. Replace `v1.3` with the new version:
   ```bash
   VERSION=v1.3
   git tag -a "$VERSION" -m "Isaac Sim Dashboard $VERSION" && git push origin "$VERSION"
   git archive --format=zip --prefix=isaac-sim-dashboard/ -o isaac-sim-dashboard.zip "$VERSION"
   awk -v v="$VERSION" '/^## /{p=($2==v); next} p' CHANGELOG.md > release-notes.md
   gh release create "$VERSION" isaac-sim-dashboard.zip --title "Isaac Sim Dashboard $VERSION" --notes-file release-notes.md
   rm isaac-sim-dashboard.zip release-notes.md
   ```

The `--prefix` makes the ZIP unpack into `isaac-sim-dashboard/`, which the install commands above expect. The `awk` line copies the new version's section of CHANGELOG.md into the release notes.
