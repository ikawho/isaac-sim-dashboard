# Isaac Sim Dashboard API v1.0

The dashboard web page uses this HTTP API for all of its work. Your own scripts and tools can call it to do the same things: start and stop a user's Isaac Sim GPU machine, read its setup progress, manage the user's private files and, for administrators, manage users and all machines.

Every installation has its own API. All requests and responses use JSON, with UTF-8 encoding.

- [Before you start](#before-you-start)
- [Authentication](#authentication)
- [Errors](#errors)
- [Endpoint overview](#endpoint-overview)
- [Account](#account): `GET /me`
- [Machine](#machine): `/instance`, `/instance/log`, `/instance/start`, `/instance/stop`, `/instance/terminate`, `/instance/allow-ip`
- [Files](#files): `/files`, `/files/upload-url`, `/files/download-url`
- [Administration](#administration): `/admin/users`, `/admin/instances`
- [Shared objects](#shared-objects): Machine status, Capacity search

---

## Before you start

You need three values from your installation: the **API URL**, the **sign-in domain** and the **client ID**. They are public, because the dashboard serves them to every browser in `config.js`. Ask your administrator for the dashboard URL, then read the three values from it:

```bash
DASHBOARD=https://d1234abcdefgh.cloudfront.net
curl -sS "$DASHBOARD/config.js"
```

```
window.APP_CONFIG = {
  apiUrl: "https://a1b2c3d4e5.execute-api.eu-central-1.amazonaws.com",
  cognitoDomain: "https://isaac-sim-dashboard-123456789012.auth.eu-central-1.amazoncognito.com",
  clientId: "4abcdefghijklmnopqrstuv567",
  region: "eu-central-1"
};
```

Store them in shell variables. All examples in this document use these variables:

```bash
CONFIG=$(curl -sS "$DASHBOARD/config.js")
API=$(printf '%s' "$CONFIG" | sed -n 's/.*apiUrl: "\([^"]*\)".*/\1/p')
COGNITO_DOMAIN=$(printf '%s' "$CONFIG" | sed -n 's/.*cognitoDomain: "\([^"]*\)".*/\1/p')
CLIENT_ID=$(printf '%s' "$CONFIG" | sed -n 's/.*clientId: "\([^"]*\)".*/\1/p')
echo "$API $COGNITO_DOMAIN $CLIENT_ID"
```

Some examples use [`jq`](https://jqlang.org/) to read values from JSON responses. It is preinstalled in AWS CloudShell; on your own computer, install it with your package manager.

**The base URL has no path prefix and no version segment.** For example, `GET /instance` is `GET https://a1b2c3d4e5.execute-api.eu-central-1.amazonaws.com/instance`.

---

## Authentication

Every endpoint requires a valid **access token** from the installation's Amazon Cognito user pool, sent as a Bearer token:

```
Authorization: Bearer <access token>
```

- Every request acts **as the signed-in user**. `/instance` and `/files` always refer to that user's own machine and files; there is no way to address another user's resources through them.
- Endpoints under `/admin/` additionally require the user to be in the `admins` group.
- Access tokens are valid for **60 minutes**. Refresh tokens are valid for **30 days**.

### Getting a token

Users can only sign in through the Cognito sign-in page in a browser (OAuth 2.0 authorization code flow with PKCE). Password sign-in through the API is disabled. For scripts, sign in once in the browser, copy the **refresh token**, and use it to get new access tokens with curl:

1. Open the dashboard and sign in as the user your script should act as.
2. In the same browser tab, open the developer tools (F12), switch to **Console**, and run:
   ```js
   sessionStorage.getItem("refresh_token")
   ```
3. Copy the value without the quotes. Close the tab when you're done. To be safe, don't click **Sign out**, because signing out can invalidate the token.
4. Exchange the refresh token for an access token:

```bash
REFRESH_TOKEN='paste-the-refresh-token-here'
TOKEN=$(curl -sS -X POST "$COGNITO_DOMAIN/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode grant_type=refresh_token \
  --data-urlencode client_id="$CLIENT_ID" \
  --data-urlencode refresh_token="$REFRESH_TOKEN" | jq -r .access_token)
```

Check that the token works:

```bash
curl -sS "$API/me" -H "Authorization: Bearer $TOKEN"
```

When you get `401 {"message":"Unauthorized"}` after an hour, run step 4 again. After 30 days, repeat steps 1–3.

Treat the refresh token like a password. Anyone who has it can act as that user for 30 days.

### Browser calls

Browsers may only call the API from the dashboard's own origin (CORS). Calls from scripts, servers and command-line tools aren't affected by this.

---

## Errors

Every error response has a JSON body. Errors come from two places, so check for both fields:

| Source | Body | Status codes |
|---|---|---|
| The API itself | `{"error": "<plain-English message>"}` | 400, 403, 404, 409, 500 |
| The API gateway, before your request reaches the API | `{"message": "<short text>"}` | 401, 404, 429, 500, 503 |

These errors can happen on **every** endpoint. Errors specific to one endpoint are listed under that endpoint.

| Status | Body | Cause |
|---|---|---|
| `401` | `{"message":"Unauthorized"}` | The `Authorization` header is missing, or the token is malformed, expired, or from another installation. Get a new access token. |
| `404` | `{"message":"Not Found"}` | No endpoint exists for this combination of method and path. Check spelling, the method, and that there is no trailing slash. |
| `429` | `{"message":"Too Many Requests"}` | You sent too many requests in a short time. Wait a few seconds and retry. |
| `500` | `{"error":"Internal error: <name>"}` | An unexpected error occurred while handling the request, for example a temporary AWS failure. `<name>` names the kind of error. Retry once; if it persists, give the name to your administrator. |
| `500` | `{"message":"Internal Server Error"}` | The API crashed before it could send a response. Retry once; if it persists, contact your administrator. |
| `503` | `{"message":"Service Unavailable"}` | The request took longer than 30 seconds and was cut off. It may still have finished in the background, so check the current state, for example with `GET /instance`, before you retry. |

All endpoints that read a JSON body can also return:

| Status | Body | Cause |
|---|---|---|
| `400` | `{"error":"Invalid JSON in request body."}` | The body isn't valid JSON. |

---

## Endpoint overview

| Method | Path | What it does | Admins only |
|---|---|---|---|
| `GET` | [`/me`](#get-me) | Returns who you are signed in as | |
| `GET` | [`/instance`](#get-instance) | Returns your machine's status | |
| `GET` | [`/instance/log`](#get-instancelog) | Returns your machine's setup log | |
| `POST` | [`/instance/start`](#post-instancestart) | Starts or creates your machine | |
| `POST` | [`/instance/stop`](#post-instancestop) | Stops your machine, keeping its disk | |
| `POST` | [`/instance/terminate`](#post-instanceterminate) | Deletes your machine and its disk | |
| `POST` | [`/instance/allow-ip`](#post-instanceallow-ip) | Lets your current IP address reach the stream | |
| `GET` | [`/files`](#get-files) | Lists your files | |
| `POST` | [`/files/upload-url`](#post-filesupload-url) | Returns a temporary upload link for one file | |
| `GET` | [`/files/download-url`](#get-filesdownload-url) | Returns a temporary download link for one file | |
| `DELETE` | [`/files`](#delete-files) | Deletes one file | |
| `GET` | [`/admin/users`](#get-adminusers) | Lists all users | Yes |
| `POST` | [`/admin/users`](#post-adminusers) | Invites a new user by email | Yes |
| `POST` | [`/admin/users/{username}`](#post-adminusersusername) | Changes a user's admin rights or enables/disables them | Yes |
| `DELETE` | [`/admin/users/{username}`](#delete-adminusersusername) | Deletes a user with their machine and files | Yes |
| `GET` | [`/admin/instances`](#get-admininstances) | Lists all machines | Yes |
| `POST` | [`/admin/instances/{id}/{action}`](#post-admininstancesidaction) | Stops or deletes any machine | Yes |

**Conventions in responses:**
- Fields that hold a date and time as a string (for example `launchTime`) use ISO 8601 in UTC, such as `2026-11-11T09:02:11+00:00`.
- Fields named `ts` or `phaseSince` are Unix timestamps in seconds, as decimal numbers.
- A field shown as `null` is present with the value `null`.
- A field described as "only when …" is missing entirely otherwise.

---

## Account

### `GET /me`

Returns the identity of the signed-in user and whether they are an administrator.

**Authentication:** any signed-in user.

**Request parameters:** none.

**Response:** `200 OK`

| Field | Type | Description |
|---|---|---|
| `sub` | string | The user's permanent unique ID. Machines and files are stored under this ID. |
| `username` | string | The user's internal user name (a UUID). Use this value for `{username}` in the admin endpoints. |
| `admin` | boolean | `true` if the user is in the `admins` group. |

**Errors:** only the [common errors](#errors).

**Example:**

```bash
curl -sS "$API/me" -H "Authorization: Bearer $TOKEN"
```

```json
{"sub": "a1b2c3d4-0000-4000-8000-123456789abc", "username": "a1b2c3d4-0000-4000-8000-123456789abc", "admin": false}
```

---

## Machine

Each user has at most one machine. The typical sequence is:

1. Call `POST /instance/start`.
2. Poll `GET /instance` every 10–15 seconds until `phase` is `ready`, or until `lastError` is set.
3. Open `viewerUrl` in a Chromium-based browser.
4. Call `POST /instance/stop` when you're done.

A first start takes 20–30 minutes; a restart of a stopped machine takes a few minutes. Machines are stopped automatically after `maxSessionHours`.

> **Important: the machine's firewall uses the IP address the request comes from.** `POST /instance/start` and `POST /instance/allow-ip` replace the allowed address with the **caller's** public IP. If your script runs on a server, the server's address is allowed, not the address of the person watching the stream. Call these two endpoints from the network where the stream will be viewed.

### `GET /instance`

Returns the current status of your machine, including its setup progress and the result of the last start.

**Authentication:** any signed-in user.

**Request parameters:** none.

**Response:** `200 OK` with a [Machine status](#machine-status) object.

**Errors:** only the [common errors](#errors).

**Example:**

```bash
curl -sS "$API/instance" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "state": "running",
  "instanceId": "i-0123456789abcdef0",
  "instanceType": "g6e.2xlarge",
  "zone": "eu-central-1a",
  "publicIp": "3.120.10.20",
  "launchTime": "2026-11-11T09:02:11+00:00",
  "owner": "a1b2c3d4-0000-4000-8000-123456789abc",
  "ownerEmail": "user@example.com",
  "runningHours": 0.42,
  "phase": "ready",
  "detail": "Isaac Sim is ready",
  "phaseSince": 1762853012.4,
  "viewerUrl": "http://3.120.10.20:8210",
  "lastError": null,
  "search": null,
  "allowedIps": ["203.0.113.7"],
  "signalPort": 49100,
  "streamPort": 47998,
  "maxSessionHours": 8.0
}
```

### `GET /instance/log`

Returns the last 300 lines of your machine's setup log.

The machine uploads this log every 15 seconds while it sets up and runs Isaac Sim. Use it to see why a start is slow or failed.

**Authentication:** any signed-in user.

**Request parameters:** none.

**Response:** `200 OK`

| Field | Type | Description |
|---|---|---|
| `log` | string | The log text, with lines separated by `\n`. Empty if the machine hasn't uploaded a log since its last start. |
| `updated` | string or `null` | When the log was last uploaded (ISO 8601). `null` if there is no log yet. |

**Errors:**

| Status | Body | Cause |
|---|---|---|
| `404` | `{"error":"No instance exists."}` | You have no machine. Start one first. |

**Example:**

```bash
curl -sS "$API/instance/log" -H "Authorization: Bearer $TOKEN" | jq -r .log | tail -20
```

```
+ 09:14:02 status pulling 'Downloading Isaac Sim container (about 20 GB on first start)'
+ 09:14:02 timeout 3600 docker pull nvcr.io/nvidia/isaac-sim:6.2.0
6.2.0: Pulling from nvidia/isaac-sim
...
```

### `POST /instance/start`

Starts your machine, or creates a new one if you have none.

The request returns immediately. The search for a free GPU machine runs in the background, so follow it with [`GET /instance`](#get-instance).

**Authentication:** any signed-in user.

**Request parameters:** none. No body is needed.

**What happens, depending on your machine's current state:**

| Current state | Effect |
|---|---|
| `none` (no machine) | Searches for a free GPU machine across all configured machine types and availability zones, and creates it. The response has `state: "requesting"`. |
| `stopped` | Restarts the machine in its own zone; it switches to a fallback machine type if its own type has no capacity. The response has `state: "requesting"`. |
| `requesting` (a start is already running) | Nothing new starts. Returns the current status. |
| `pending` or `running` | Nothing starts. The firewall is set to the caller's IP address (like [`allow-ip`](#post-instanceallow-ip)), and the current status is returned. |
| `stopping` | Fails with `409`. |

In every case that starts something, the machine's firewall is set to the caller's IP address.

**Response:** `200 OK` with a [Machine status](#machine-status) object.

**Errors:**

| Status | Body | Cause |
|---|---|---|
| `409` | `{"error":"The instance is currently stopping. Please wait a moment and start it again."}` | The machine is shutting down. Wait until `GET /instance` shows `stopped`, then retry. |

**Failures during the background search** don't appear in this response. `GET /instance` then shows `state` `none` or `stopped`, with the reason in `lastError` and the full search result in `search`. These messages stay visible for one hour:

| `lastError` | Cause |
|---|---|
| `No GPU capacity available right now (tried: <types>). Please try again in a few minutes.` | AWS had no free machine of any configured type in any zone. Try again later. |
| `The vCPU quota for G instances is exhausted. Please increase 'Running On-Demand G and VT instances' in Service Quotas.` | The AWS account isn't allowed to run more GPU machines. An administrator has to request a higher quota. |
| `Starting the machine timed out. Please try again.` | The background search didn't finish within 10 minutes. |
| `Internal error while starting: <name>` | An unexpected AWS error. Retry once, then contact your administrator. |

**Example:**

```bash
curl -sS -X POST "$API/instance/start" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "state": "requesting",
  "detail": "Looking for free GPU capacity",
  "search": {
    "phase": "requesting",
    "detail": "Looking for free GPU capacity",
    "ts": 1762851700.1,
    "zones": ["eu-central-1a", "eu-central-1b", "eu-central-1c"],
    "types": ["g6e.2xlarge", "g6e.xlarge", "g6.2xlarge", "g5.2xlarge", "g6.4xlarge", "g5.4xlarge", "g4dn.2xlarge"],
    "attempts": {}
  },
  "instanceType": null,
  "maxSessionHours": 8.0
}
```

Wait until the machine is ready:

```bash
while :; do
  S=$(curl -sS "$API/instance" -H "Authorization: Bearer $TOKEN")
  echo "$S" | jq -r '"\(.state)  \(.phase // "-")  \(.detail // "")"'
  [ "$(echo "$S" | jq -r .phase)" = ready ] && { echo "$S" | jq -r .viewerUrl; break; }
  [ "$(echo "$S" | jq -r '.lastError // empty')" != "" ] && { echo "$S" | jq -r .lastError; break; }
  [ "$(echo "$S" | jq -r .phase)" = error ] && { echo "$S" | jq -r .detail; break; }
  sleep 15
done
```

### `POST /instance/stop`

Shuts down your machine but keeps its disk, so the next start is fast. Your files are copied back to storage while the machine shuts down.

**Authentication:** any signed-in user.

**Request parameters:** none. No body is needed.

**Response:** `200 OK` with a [Machine status](#machine-status) object, usually with `state: "stopping"`. If the machine is already `stopping` or `stopped`, nothing happens and the current status is returned.

**Errors:**

| Status | Body | Cause |
|---|---|---|
| `404` | `{"error":"No instance exists."}` | You have no machine. |

**Example:**

```bash
curl -sS -X POST "$API/instance/stop" -H "Authorization: Bearer $TOKEN"
```

```json
{"state": "stopping", "instanceId": "i-0123456789abcdef0", "instanceType": "g6e.2xlarge", "zone": "eu-central-1a", "publicIp": null, "launchTime": "2026-11-11T09:02:11+00:00", "owner": "a1b2c3d4-0000-4000-8000-123456789abc", "ownerEmail": "user@example.com", "runningHours": null, "lastError": null, "search": null, "allowedIps": ["203.0.113.7"], "signalPort": 49100, "streamPort": 47998, "maxSessionHours": 8.0}
```

### `POST /instance/terminate`

Permanently deletes your machine and its disk.

Your files in storage are kept. The next start is a full first start again, which takes 20–30 minutes. This can't be undone.

**Authentication:** any signed-in user.

**Request parameters:** none. No body is needed.

**Response:** `200 OK`

| Field | Type | Description |
|---|---|---|
| `state` | string | Always `"shutting-down"`. A few seconds later, `GET /instance` returns `state: "none"`. |

**Errors:**

| Status | Body | Cause |
|---|---|---|
| `404` | `{"error":"No instance exists."}` | You have no machine. |

**Example:**

```bash
curl -sS -X POST "$API/instance/terminate" -H "Authorization: Bearer $TOKEN"
```

```json
{"state": "shutting-down"}
```

### `POST /instance/allow-ip`

Replaces the machine's firewall rules so that only the caller's current public IP address can reach the stream.

Call it after changing networks, for example to another Wi-Fi or a VPN. Both IPv4 and IPv6 addresses work. Any previously allowed address loses access.

**Authentication:** any signed-in user.

**Request parameters:** none. No body is needed. The IP address is taken from the request itself.

**Response:** `200 OK` with a [Machine status](#machine-status) object. `allowedIps` contains the new address.

**Errors:**

| Status | Body | Cause |
|---|---|---|
| `404` | `{"error":"No instance exists."}` | You have no machine. |

**Example:**

```bash
curl -sS -X POST "$API/instance/allow-ip" -H "Authorization: Bearer $TOKEN" | jq .allowedIps
```

```json
["198.51.100.23"]
```

---

## Files

Each user has a private file storage area, and the user's machine keeps a copy of it in `/workspace`:

- **Storage to machine:** files are copied once, while the machine starts (phase `syncing`). A file you upload while the machine is running appears there only after the next start.
- **Machine to storage:** new and changed files are copied back every 2 minutes and when the machine stops.
- **Deletions are not copied in either direction.**

**File names** are paths relative to your storage area, for example `scene.usd` or `robots/arm/arm.usd`:

- Use `/` to create folders.
- A leading `/` is ignored.
- A name must not be empty.
- A name must not point outside your area (for example `../other.usd`).
- A name must be at most 900 characters long.

Uploads and downloads don't go through the API. The API gives you a temporary direct link to the storage (Amazon S3), and you send the file to that link or fetch it from there. Each link works for **15 minutes**, for one file.

### `GET /files`

Lists all files in your storage area, sorted by name, ignoring case.

**Authentication:** any signed-in user.

**Request parameters:** none.

**Response:** `200 OK`

| Field | Type | Description |
|---|---|---|
| `files` | array | One object per file. Empty if you have no files. |
| `files[].name` | string | The file's path relative to your storage area. |
| `files[].size` | integer | Size in bytes. |
| `files[].lastModified` | string | When the file was last written (ISO 8601). |

**Errors:** only the [common errors](#errors).

**Example:**

```bash
curl -sS "$API/files" -H "Authorization: Bearer $TOKEN"
```

```json
{"files": [
  {"name": "robots/arm/arm.usd", "size": 2483021, "lastModified": "2026-11-10T14:22:05+00:00"},
  {"name": "scene.usd", "size": 104857, "lastModified": "2026-11-11T08:01:44+00:00"}
]}
```

### `POST /files/upload-url`

Returns a temporary link for uploading one file to your storage area.

If a file with the same name exists, uploading replaces it.

**Authentication:** any signed-in user.

**Request body** (`Content-Type: application/json`):

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Required | The name the file should have, following the [file name rules](#files). |

**Response:** `200 OK`

| Field | Type | Description |
|---|---|---|
| `url` | string | Upload link, valid for 15 minutes. Send the file content to it with an HTTP `PUT` request, with no `Authorization` header. A single upload can be up to 5 GB. |

**Errors:**

| Status | Body | Cause |
|---|---|---|
| `400` | `{"error":"Invalid file name."}` | `name` is missing or empty, points outside your storage area, or is longer than 900 characters. |
| `400` | `{"error":"Invalid JSON in request body."}` | The body isn't valid JSON. |

When the upload itself (the `PUT` to `url`) fails, S3 answers with an XML error instead. The most common one is `403 AccessDenied` with `Request has expired`: the link is older than 15 minutes, so request a new one.

**Example:**

```bash
UPLOAD_URL=$(curl -sS -X POST "$API/files/upload-url" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "scenes/warehouse.usd"}' | jq -r .url)
curl -sS --fail -T ./warehouse.usd "$UPLOAD_URL" && echo "uploaded"
```

The first call returns:

```json
{"url": "https://isaac-sim-dashboard-files-123456789012.s3.eu-central-1.amazonaws.com/users/a1b2c3d4-.../scenes/warehouse.usd?X-Amz-Algorithm=AWS4-HMAC-SHA256&..."}
```

### `GET /files/download-url`

Returns a temporary link for downloading one file from your storage area.

**Authentication:** any signed-in user.

**Query parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | Required | The file's name as returned by [`GET /files`](#get-files). URL-encode it. |

**Response:** `200 OK`

| Field | Type | Description |
|---|---|---|
| `url` | string | Download link, valid for 15 minutes. Fetch it with an HTTP `GET` request, with no `Authorization` header. Browsers save the file under its own name. |

**Errors:**

| Status | Body | Cause |
|---|---|---|
| `400` | `{"error":"Invalid file name."}` | `name` is missing or empty, points outside your storage area, or is longer than 900 characters. |

The API doesn't check whether the file exists. For a file that doesn't exist, the link itself fails with an S3 `404 NoSuchKey` error.

**Example:**

```bash
DOWNLOAD_URL=$(curl -sS -G "$API/files/download-url" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "name=scenes/warehouse.usd" | jq -r .url)
curl -sS --fail -o warehouse.usd "$DOWNLOAD_URL" && echo "downloaded"
```

### `DELETE /files`

Deletes one file from your storage area.

This only deletes the stored copy. If your machine, running or stopped, still has the file in `/workspace`, the machine uploads it again at its next sync. Delete the file on the machine as well, or delete the machine first.

**Authentication:** any signed-in user.

**Query parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | Required | The file's name as returned by [`GET /files`](#get-files). URL-encode it. |

**Response:** `200 OK`

| Field | Type | Description |
|---|---|---|
| `deleted` | boolean | Always `true`. This is also returned when no file with that name existed. |

**Errors:**

| Status | Body | Cause |
|---|---|---|
| `400` | `{"error":"Invalid file name."}` | `name` is missing or empty, points outside your storage area, or is longer than 900 characters. |

**Example:**

```bash
curl -sS -G -X DELETE "$API/files" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "name=scenes/warehouse.usd"
```

```json
{"deleted": true}
```

---

## Administration

All endpoints in this section require the signed-in user to be in the `admins` group. For everyone else, they return:

| Status | Body | Cause |
|---|---|---|
| `403` | `{"error":"Only administrators are allowed to do this."}` | The signed-in user isn't an administrator. |

A user who was just made an administrator gets admin rights with their next access token, at the latest after 60 minutes. Refresh the token to get them right away.

### `GET /admin/users`

Lists all users of the installation, sorted by email address, with their machine's state.

**Request parameters:** none.

**Response:** `200 OK`

| Field | Type | Description |
|---|---|---|
| `users` | array | One object per user. |
| `users[].username` | string | Internal user name (a UUID). Use it as `{username}` in the endpoints below. |
| `users[].email` | string | The user's email address, which is also their sign-in name. |
| `users[].sub` | string | The user's permanent unique ID. It matches `owner` in machine objects. |
| `users[].status` | string | The account's sign-up status: `FORCE_CHANGE_PASSWORD` means invited but not signed in yet, and `CONFIRMED` means active. Other values come from Amazon Cognito, for example `RESET_REQUIRED`. |
| `users[].enabled` | boolean | `false` if the account is disabled and can't sign in. |
| `users[].created` | string | When the account was created (ISO 8601). |
| `users[].admin` | boolean | `true` if the user is in the `admins` group. |
| `users[].instance` | string | The state of the user's machine (`pending`, `running`, `stopping` or `stopped`), or `none`. |

**Errors:** `403` (see above) and the [common errors](#errors).

**Example:**

```bash
curl -sS "$API/admin/users" -H "Authorization: Bearer $TOKEN"
```

```json
{"users": [
  {"username": "a1b2c3d4-0000-4000-8000-123456789abc", "email": "user@example.com", "sub": "a1b2c3d4-0000-4000-8000-123456789abc",
   "status": "CONFIRMED", "enabled": true, "created": "2026-11-03T10:15:00.123000+00:00", "admin": false, "instance": "running"}
]}
```

### `POST /admin/users`

Creates a user account and sends the user an invitation email with a temporary password.

The temporary password is valid for 7 days; the user must set a new password at first sign-in.

**Request body** (`Content-Type: application/json`):

| Field | Type | Required | Description |
|---|---|---|---|
| `email` | string | Required | The user's email address. Leading and trailing spaces are removed, and it is stored in lower case. |
| `admin` | boolean | Optional | `true` to make the user an administrator right away. Default: `false`. |

**Response:** `201 Created`

| Field | Type | Description |
|---|---|---|
| `username` | string | The new user's internal user name (a UUID). |
| `email` | string | The email address as stored. |

**Errors:**

| Status | Body | Cause |
|---|---|---|
| `400` | `{"error":"Please enter a valid email address."}` | `email` is missing or contains no `@`. |
| `409` | `{"error":"This email address is already registered."}` | A user with this email address already exists. |
| `500` | `{"error":"Internal error: InvalidParameterException"}` | Amazon Cognito rejected the address as malformed, for example `name@`. |

**Example:**

```bash
curl -sS -X POST "$API/admin/users" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email": "new.user@example.com", "admin": false}'
```

```json
{"username": "f9e8d7c6-0000-4000-8000-abcdef012345", "email": "new.user@example.com"}
```

### `POST /admin/users/{username}`

Grants or removes a user's admin rights, and enables or disables their account.

Disabling an account blocks new sign-ins. It doesn't stop the user's running machine, and this API keeps accepting access tokens the user already holds until they expire (up to 60 minutes).

**Path parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `username` | string | Required | The user's `username` from [`GET /admin/users`](#get-adminusers). |

**Request body** (`Content-Type: application/json`). Send at least one field; fields you leave out are not changed.

| Field | Type | Required | Description |
|---|---|---|---|
| `admin` | boolean | Optional | `true` adds the user to the `admins` group; `false` removes them from it. |
| `enabled` | boolean | Optional | `true` enables the account; `false` disables it. |

**Response:** `200 OK`

| Field | Type | Description |
|---|---|---|
| `updated` | boolean | Always `true`. |

**Errors:**

| Status | Body | Cause |
|---|---|---|
| `400` | `{"error":"You cannot remove your own admin rights or disable your own account."}` | `username` is your own account, and the body sets `admin` or `enabled` to `false`. This prevents locking every admin out. |
| `400` | `{"error":"Invalid JSON in request body."}` | The body isn't valid JSON. |
| `500` | `{"error":"Internal error: UserNotFoundException"}` | No user with this `username` exists. |

**Example:**

```bash
curl -sS -X POST "$API/admin/users/f9e8d7c6-0000-4000-8000-abcdef012345" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"admin": true}'
```

```json
{"updated": true}
```

### `DELETE /admin/users/{username}`

Permanently deletes a user, their machine, and all of their stored files.

This can't be undone.

**Path parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `username` | string | Required | The user's `username` from [`GET /admin/users`](#get-adminusers). |

**Request parameters:** no query parameters and no body.

**Response:** `200 OK`

| Field | Type | Description |
|---|---|---|
| `deleted` | boolean | Always `true`. |

**Errors:**

| Status | Body | Cause |
|---|---|---|
| `400` | `{"error":"You cannot delete your own account."}` | `username` is your own account. |
| `404` | `{"error":"User not found."}` | No user with this `username` exists. |

**Example:**

```bash
curl -sS -X DELETE "$API/admin/users/f9e8d7c6-0000-4000-8000-abcdef012345" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{"deleted": true}
```

### `GET /admin/instances`

Lists every machine of the installation that isn't deleted, with its owner and setup progress.

**Request parameters:** none.

**Response:** `200 OK`

| Field | Type | Description |
|---|---|---|
| `instances` | array | One object per machine. |

Each object has the machine fields of the [Machine status](#machine-status) object, from `state` to `viewerUrl`: `state`, `instanceId`, `instanceType`, `zone`, `publicIp`, `launchTime`, `owner`, `ownerEmail` and `runningHours`, plus `phase`, `detail`, `phaseSince` and `viewerUrl` while the machine is running. It doesn't contain `lastError`, `search`, `allowedIps`, `signalPort`, `streamPort` or `maxSessionHours`.

**Errors:** `403` (see above) and the [common errors](#errors).

**Example:**

```bash
curl -sS "$API/admin/instances" -H "Authorization: Bearer $TOKEN"
```

```json
{"instances": [
  {"state": "running", "instanceId": "i-0123456789abcdef0", "instanceType": "g6e.2xlarge", "zone": "eu-central-1a",
   "publicIp": "3.120.10.20", "launchTime": "2026-11-11T09:02:11+00:00", "owner": "a1b2c3d4-0000-4000-8000-123456789abc",
   "ownerEmail": "user@example.com", "runningHours": 0.42, "phase": "starting",
   "detail": "Isaac Sim is starting (first start builds the shader cache: 15 minutes or more)", "phaseSince": 1762852410.7}
]}
```

### `POST /admin/instances/{id}/{action}`

Stops or permanently deletes any user's machine.

**Path parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | Required | The machine's `instanceId` from [`GET /admin/instances`](#get-admininstances), for example `i-0123456789abcdef0`. |
| `action` | string | Required | `stop` shuts the machine down and keeps its disk. `terminate` deletes the machine and its disk; the user's files are kept. |

**Request parameters:** no query parameters and no body.

**Response:** `200 OK`

| Field | Type | Description |
|---|---|---|
| `ok` | boolean | Always `true`. |

**Errors:**

| Status | Body | Cause |
|---|---|---|
| `400` | `{"error":"Action must be 'stop' or 'terminate'."}` | `action` is something other than `stop` or `terminate`. |
| `404` | `{"error":"Instance not found."}` | The machine exists in the AWS account but doesn't belong to this installation. |
| `500` | `{"error":"Internal error: ClientError"}` | `id` isn't a valid machine ID, or no machine with this ID exists. |

**Example:**

```bash
curl -sS -X POST "$API/admin/instances/i-0123456789abcdef0/stop" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{"ok": true}
```

---

## Shared objects

### Machine status

Returned by `GET /instance`, `POST /instance/start`, `POST /instance/stop` and `POST /instance/allow-ip`. Its fields depend on `state`.

**`state` values:**

| Value | Meaning |
|---|---|
| `none` | You have no machine. |
| `requesting` | A start is in progress: the API is looking for free GPU capacity. |
| `pending` | AWS is booting the machine. |
| `running` | The machine is on. Check `phase` for Isaac Sim's progress. |
| `stopping` | The machine is shutting down. |
| `stopped` | The machine is off; its disk is kept. |

**When `state` is `requesting`:**

| Field | Type | Description |
|---|---|---|
| `state` | string | `"requesting"`. |
| `detail` | string | Human-readable progress text. |
| `search` | object | The [Capacity search](#capacity-search). |
| `instanceType` | string or `null` | The type of the stopped machine being restarted, or `null` when a new machine is created. |
| `maxSessionHours` | number | Hours after which a running machine is stopped automatically. |

**When `state` is `none`:**

| Field | Type | Description |
|---|---|---|
| `state` | string | `"none"`. |
| `lastError` | string or `null` | Why the last start failed, if it failed within the last hour. Otherwise `null`. |
| `search` | object or `null` | The [Capacity search](#capacity-search) of the last start, for one hour after it ended. Otherwise `null`. |

**When a machine exists** (`pending`, `running`, `stopping`, `stopped`):

| Field | Type | Description |
|---|---|---|
| `state` | string | See the table above. |
| `instanceId` | string | AWS ID of the machine, for example `i-0123456789abcdef0`. |
| `instanceType` | string | AWS machine type, for example `g6e.2xlarge`. |
| `zone` | string | AWS availability zone, for example `eu-central-1a`. |
| `publicIp` | string or `null` | The machine's public IP address. `null` while it is stopped. It changes on every start. |
| `launchTime` | string | When the machine was last started (ISO 8601). |
| `owner` | string | The owner's `sub`. |
| `ownerEmail` | string | The owner's email address. |
| `runningHours` | number or `null` | Hours since `launchTime`, rounded to 2 decimals. `null` unless `state` is `running`. |
| `phase` | string | Only when `running`. Isaac Sim's setup progress; see the next table. |
| `detail` | string | Only when `running`. Human-readable progress text, or the error message when `phase` is `error`. |
| `phaseSince` | number | Only when `running` and the machine has reported progress. When the current phase began (Unix seconds). |
| `viewerUrl` | string | Only when `phase` is `ready`. The address to open in the browser to see the stream. It only works from an address in `allowedIps`, and needs a Chromium-based browser. |
| `lastError` | string or `null` | Why the last start failed, if `state` is `stopped` and the start failed within the last hour. Otherwise `null`. |
| `search` | object or `null` | The [Capacity search](#capacity-search) of the last start, for one hour after it ended. Otherwise `null`. |
| `allowedIps` | array of strings | IP addresses that may reach the stream. |
| `signalPort` | integer | TCP port for stream signaling (`49100`). The viewer uses it automatically. |
| `streamPort` | integer | UDP port for the video stream (`47998`). The viewer uses it automatically. |
| `maxSessionHours` | number | Hours after which a running machine is stopped automatically. |

**`phase` values,** in the order they normally occur:

| Value | Meaning |
|---|---|
| `booting` | The operating system is starting. The machine hasn't reported progress yet. |
| `setup` | Installing Docker and NVIDIA tools. This happens on the first start only. |
| `pulling` | Downloading the Isaac Sim container (about 20 GB). This happens on the first start only. |
| `syncing` | Copying your files from storage to `/workspace`. |
| `building` | Building the web viewer for the machine's current IP address. |
| `starting` | Isaac Sim is starting. The first start builds the shader cache, which takes 15 minutes or more. |
| `ready` | Isaac Sim is ready. Open `viewerUrl`. |
| `error` | Setup failed. `detail` has the reason, and [`GET /instance/log`](#get-instancelog) has the details. Stop and start the machine to retry, or delete it to start from scratch. |

### Capacity search

Describes the most recent search for a free GPU machine. A start tries every machine type in every zone, in order, until one works. A restart of a stopped machine tries only the machine's own zone.

| Field | Type | Description |
|---|---|---|
| `phase` | string | `requesting` while the search runs, `launched` when a machine was found, `error` when none was found. |
| `detail` | string | Human-readable result, or the error message. |
| `ts` | number | When the search last changed (Unix seconds). |
| `zones` | array of strings | Availability zones in the order they are tried. |
| `types` | array of strings | Machine types in the order they are tried. |
| `attempts` | object | One entry per combination tried so far, keyed `"<type>\|<zone>"`, for example `"g6e.2xlarge\|eu-central-1a"`. Combinations not tried yet are missing while the search runs. |
| `attempts.*.result` | string | The outcome; see the next table. |
| `attempts.*.code` | string or `null` | The AWS error code, for example `InsufficientInstanceCapacity`, or `null`. |

**`result` values:**

| Value | Meaning |
|---|---|
| `trying` | Being tried right now. |
| `launched` | A machine was started with this combination. |
| `no_capacity` | AWS has no free machine of this type in this zone right now. |
| `not_offered` | This machine type isn't available in this zone. |
| `quota` | The account's GPU quota doesn't allow this machine type. |
| `skipped_quota` | Not tried, because the same type already failed on the quota in another zone. |
| `error` | Another AWS error; see `code`. |
| `not_tried` | Not tried, because the search ended before reaching this combination. |

**Example** (one zone without capacity, the second zone worked):

```json
{
  "phase": "launched",
  "detail": "Machine found and started",
  "ts": 1762851712.9,
  "zones": ["eu-central-1a", "eu-central-1b", "eu-central-1c"],
  "types": ["g6e.2xlarge", "g6e.xlarge"],
  "attempts": {
    "g6e.2xlarge|eu-central-1a": {"result": "no_capacity", "code": "InsufficientInstanceCapacity"},
    "g6e.2xlarge|eu-central-1b": {"result": "launched", "code": null},
    "g6e.2xlarge|eu-central-1c": {"result": "not_tried", "code": null},
    "g6e.xlarge|eu-central-1a": {"result": "not_tried", "code": null},
    "g6e.xlarge|eu-central-1b": {"result": "not_tried", "code": null},
    "g6e.xlarge|eu-central-1c": {"result": "not_tried", "code": null}
  }
}
```
