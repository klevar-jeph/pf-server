# Patients Flow mail API

Small Express service for the website contact form and newsletter sign-ups. It sends messages through the ZeptoMail Node.js SDK; the API key stays on the server.

## Requirements

- Node.js 20 or newer
- A ZeptoMail agent API key and a verified sender address

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Set `ZEPTOMAIL_API_KEY` in `.env` to the API key for the configured ZeptoMail agent. The key may be pasted with or without the leading `Zoho-enczapikey ` prefix shown in the ZeptoMail dashboard; the server strips a stray prefix and adds it exactly once. Sending the prefix twice makes Zoho answer with an opaque HTTP 500 and an empty response body. The sender address must be verified in ZeptoMail. Keep `.env` private and do not commit it.

The ZeptoMail SDK sends through the agent-specific API key; it does not require a separate agent-alias field in the message request. The API logs a startup configuration summary and delivery stage for mail failures. It never logs the API key or submitted contact details.

## Logging

Set `LOG_LEVEL` in `.env` to `error`, `warn`, `info`, or `debug`. Outside production the default is `debug`, so `npm run dev` prints the full mail trail; production defaults to `info`.

On startup the API runs a credential self-check against ZeptoMail and logs `credentials accepted`, `AUTH FAILED`, or `PROVIDER ERROR` with an actionable hint. The startup summary includes `apiKeyHadAuthPrefix` (a stray prefix in `.env`), `apiKeyFingerprint` (a short hash confirming which key is loaded, never the key itself), and `apiKeyLength`.

Each send logs `send.request` and `send.success` with the endpoint, subject, recipient domain, duration, and the provider request ID to quote in a ZeptoMail support ticket. Failures log the request ID, delivery stage, HTTP status, and a body snippet alongside the safe provider error fields.

## Run

```powershell
npm run dev
```

The API listens on `http://localhost:4000` by default. `npm run dev` uses nodemon to restart the server when files change. Set `NEXT_PUBLIC_API_URL` in the frontend to the deployed API origin and update `FRONTEND_ORIGINS` to the exact frontend origins.

## Endpoints

- `GET /health` — service health check.
- `POST /api/contact` — validates and emails a contact enquiry to `CONTACT_INBOX`, then sends an acknowledgement to the visitor. The phone number must be E.164 (for example, `+447123456789`), and the visitor's address is configured as Reply-To for the inbox message.
- `POST /api/newsletter` — requires `{ "email": "...", "consent": true }`, emails the inbox about the signup, then sends a confirmation to the subscriber. This endpoint does not retain a subscriber list.

Both submission endpoints have per-IP rate limits and input validation. The newsletter form and its consent are shown in the shared footer on all frontend pages.

## Troubleshooting email delivery

When ZeptoMail rejects a send, the backend logs the request ID, delivery stage, and safe provider error fields. Authorization details and submitted contact information are not logged; clients receive a generic error response if the enquiry notification itself fails. If the enquiry notification succeeds but the visitor acknowledgement fails, the API logs the acknowledgement failure and still confirms receipt to prevent duplicate submissions. Use the `X-Request-Id` response header to match a failed request to its backend log entry.

## Troubleshooting CORS

Browsers send a preflight `OPTIONS` request before `POST /api/contact` and `POST /api/newsletter`. The origin must appear in `FRONTEND_ORIGINS`, otherwise the preflight gets no `Access-Control-Allow-Origin` header and the browser blocks the call with:

```
No 'Access-Control-Allow-Origin' header is present on the requested resource
```

List **every** host the frontend is served from, including the apex domain if the site is reachable without `www` — `https://patientsflow.co.uk` and `https://www.patientsflow.co.uk` are different origins. Origins are compared lowercased and without a trailing slash.

The backend always allows `https://patientsflow.co.uk` and `https://app.patientsflow.co.uk` (as well as localhost for development). Add any other frontend origins to `FRONTEND_ORIGINS` in the hosting environment, such as the Render dashboard; `.env` is not committed and is not read in production.

Verify an origin against a running instance:

```powershell
curl.exe -sS -D - -o NUL -X OPTIONS `
  -H "Origin: https://patientsflow.co.uk" `
  -H "Access-Control-Request-Method: POST" `
  http://localhost:4000/api/contact
```

A configured origin returns `204` with `access-control-allow-origin`; an unlisted one returns `404` with no CORS headers.

## Test

```powershell
npm test
```
