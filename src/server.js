import "dotenv/config";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { SendMailClient } from "zeptomail";
import { createHash, randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 4000);

// Origins are compared in their canonical form (lowercased, no trailing
// slash) so a stray "/" or mixed case in FRONTEND_ORIGINS cannot silently
// fail a match. Both the apex and "www" host are listed because the site is
// reachable on either; browsers send the exact origin they were served from.
function canonicalOrigin(value) {
  return String(value || "").trim().toLowerCase().replace(/\/+$/, "");
}

const defaultOrigins = [
  "http://localhost:3000",
  "https://patientsflow.co.uk",
  "https://app.patientsflow.co.uk",
];
const configuredOrigins = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map(canonicalOrigin)
  .filter(Boolean);
const origins = [...new Set([...defaultOrigins, ...configuredOrigins].map(canonicalOrigin))];

function isAllowedOrigin(origin) {
  return Boolean(origin) && origins.includes(canonicalOrigin(origin));
}

// The ZeptoMail authorisation header is "Zoho-enczapikey <key>". Users often
// paste the key straight from the ZeptoMail dashboard with that prefix already
// attached. Sending the prefix twice makes Zoho's gateway answer with an
// opaque HTTP 500 and an empty body, so normalise the configured value down to
// the bare key and attach the prefix exactly once below.
const AUTH_HEADER_PREFIX = "Zoho-enczapikey";

export function normalizeApiKey(value) {
  return (value || "")
    .trim()
    .replace(new RegExp(`^${AUTH_HEADER_PREFIX}\\s+`, "i"), "")
    .trim();
}

const rawApiKey = (process.env.ZEPTOMAIL_API_KEY || "").trim();
const mailConfig = {
  host: (process.env.ZEPTOMAIL_HOST || "https://cpaas.zoho.com").replace(/\/$/, ""),
  apiKey: normalizeApiKey(process.env.ZEPTOMAIL_API_KEY),
  fromAddress: process.env.MAIL_FROM_ADDRESS || "contact@app.patientsflow.co.uk",
  fromName: process.env.MAIL_FROM_NAME || "Patients Flow",
  inbox: process.env.CONTACT_INBOX || "contact@app.patientsflow.co.uk",
};
const mailUrl = `${mailConfig.host}/v1.1/email`;
const mailToken = mailConfig.apiKey
  ? `${AUTH_HEADER_PREFIX} ${mailConfig.apiKey}`
  : null;
const mailTimeoutMs = Number(process.env.MAIL_TIMEOUT_MS || 30000);
const mailClient = mailConfig.apiKey
  ? new SendMailClient({ url: mailUrl, token: mailToken })
  : null;
if (mailClient) {
  preserveProviderHttpStatus(mailClient);
}

// Logging levels: error > warn > info > debug. Failures always log; per-send
// detail (endpoint, timing, provider response codes) logs at debug, which is
// the default outside production so `npm run dev` shows the full trail.
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const defaultLogLevel =
  process.env.NODE_ENV === "test"
    ? "error"
    : process.env.NODE_ENV === "production"
      ? "info"
      : "debug";
const logLevelName = (process.env.LOG_LEVEL || defaultLogLevel).toLowerCase();
const logLevel = LOG_LEVELS[logLevelName] ?? LOG_LEVELS.info;

function logAt(levelName, label, details) {
  if (logLevel < LOG_LEVELS[levelName]) return;
  const method = levelName === "error" || levelName === "warn" ? levelName : "info";
  console[method](`[mail:${levelName}] ${label}`, details);
}

const logDebug = (label, details) => logAt("debug", label, details);
const logInfo = (label, details) => logAt("info", label, details);

// Logs only the domain part of an address so failures stay traceable without
// writing visitor contact details to the log stream.
function addressDomain(address) {
  const value = typeof address === "string" ? address.trim() : "";
  const at = value.lastIndexOf("@");
  return at === -1 ? null : value.slice(at + 1).toLowerCase() || null;
}

// Short, stable fingerprint of the loaded key. Lets an operator confirm which
// key the process is using without ever printing the key itself.
function keyFingerprint(key) {
  return key ? createHash("sha256").update(key).digest("hex").slice(0, 8) : null;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const e164Pattern = /^\+[1-9]\d{7,14}$/;
const callingCodePattern = /^\+[1-9]\d{0,2}$/;

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validEmail(value) {
  return value.length <= 254 && emailPattern.test(value);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function mailAddress(address, name) {
  return {
    email_address: { address, ...(name ? { name } : {}) },
  };
}

export function preserveProviderHttpStatus(client) {
  const originalStatus = client.status.bind(client);
  client.status = (response) => {
    if (!response.ok) {
      const parseJson = response.json.bind(response);
      response.json = async () => {
        // Read the raw body first (when available) so an empty or non-JSON
        // reply still leaves a snippet in the log instead of a bare 500.
        let rawBody = "";
        let readRawBody = false;
        try {
          if (typeof response.text === "function") {
            rawBody = await response.text();
            readRawBody = true;
          }
        } catch {
          readRawBody = false;
        }

        let data;
        if (readRawBody) {
          try {
            data = rawBody ? JSON.parse(rawBody) : undefined;
          } catch {
            data = undefined;
          }
        } else {
          try {
            data = await parseJson();
          } catch {
            data = undefined;
          }
        }

        const extras = {
          statusCode: response.status,
          statusText: response.statusText,
        };

        if (data && typeof data === "object" && !Array.isArray(data)) {
          return { ...data, ...extras };
        }
        if (Array.isArray(data)) {
          return { data, ...extras };
        }

        return {
          message: "Provider returned an empty or non-JSON error response.",
          responseBody: rawBody ? rawBody.slice(0, 300) : "",
          ...extras,
        };
      };
    }

    return originalStatus(response);
  };
  return client;
}

function safeProviderDetails(body, sensitiveValues) {
  const allowedKeys = new Set([
    "name",
    "code",
    "error_code",
    "errorCode",
    "status",
    "request_id",
    "requestId",
    "statusCode",
    "status_code",
    "statusText",
    "message",
    "error",
    "description",
    "data",
    "details",
    "response",
    "responseBody",
  ]);

  const redact = (value) => {
    let safeValue = String(value);
    for (const sensitiveValue of sensitiveValues) {
      if (sensitiveValue) {
        safeValue = safeValue.replaceAll(sensitiveValue, "[redacted]");
      }
    }
    return safeValue
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted email]")
      .replace(/\+?\d[\d\s().-]{6,}\d/g, "[redacted phone]")
      .slice(0, 1000);
  };

  const pickSafeFields = (value, depth = 0) => {
    if (depth > 3) return "[details omitted]";
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) {
      return value.slice(0, 5).map((item) => pickSafeFields(item, depth + 1));
    }
    if (!value || typeof value !== "object") return value;

    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => allowedKeys.has(key))
        .slice(0, 10)
        .map(([key, item]) => [key, pickSafeFields(item, depth + 1)]),
    );
  };

  try {
    return pickSafeFields(JSON.parse(body));
  } catch {
    return { responseBody: "Non-JSON response omitted", responseLength: body.length };
  }
}

async function sendZeptoMail({ to, subject, text, html, replyTo }) {
  if (!mailClient) {
    throw new Error("ZeptoMail API key is not configured.");
  }

  const startedAt = Date.now();
  logDebug("send.request", {
    endpoint: mailUrl,
    subject,
    toDomain: addressDomain(to.address),
    hasReplyTo: Boolean(replyTo),
  });

  try {
    const result = await mailClient.sendMail({
      from: { address: mailConfig.fromAddress, name: mailConfig.fromName },
      to: [mailAddress(to.address, to.name)],
      ...(replyTo ? { reply_to: [{ address: replyTo.address, name: replyTo.name }] } : {}),
      subject,
      textbody: text,
      htmlbody: html,
      track_clicks: false,
      track_opens: false,
    });
    logDebug("send.success", {
      endpoint: mailUrl,
      subject,
      durationMs: Date.now() - startedAt,
      providerRequestId: result?.request_id ?? null,
    });
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const details = error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          statusCode: error.statusCode,
          statusText: error.statusText,
          code: error.code,
          data: error.data,
          response: error.response,
        }
      : error && typeof error === "object"
        ? error
        : { message: error };
    const providerResponse = JSON.stringify(details);
    const mailError = new Error("ZeptoMail email request failed.");
    mailError.providerDetails = {
      response: safeProviderDetails(providerResponse, [
        mailConfig.apiKey,
        rawApiKey,
        mailToken,
        `${AUTH_HEADER_PREFIX} ${mailConfig.apiKey}`,
        to.address,
        to.name,
        replyTo?.address,
        replyTo?.name,
        subject,
        text,
        html,
      ]),
    };
    mailError.mailDiagnostics = {
      endpoint: mailUrl,
      subject,
      toDomain: addressDomain(to.address),
      durationMs,
      httpStatus: typeof details?.statusCode === "number" ? details.statusCode : null,
    };
    throw mailError;
  }
}

function logConfiguration() {
  console.info("Mail API configuration:", {
    environment: process.env.NODE_ENV || "development",
    port: PORT,
    logLevel: logLevelName,
    frontendOrigins: origins,
    zeptoMail: {
      endpoint: mailUrl,
      apiKeyConfigured: Boolean(mailConfig.apiKey),
      // Logs how the key was stored so a stray "Zoho-enczapikey " prefix in
      // .env is visible immediately; the key itself is never printed.
      apiKeyHadAuthPrefix: /^Zoho-enczapikey\s+/i.test(rawApiKey),
      apiKeyFingerprint: keyFingerprint(mailConfig.apiKey),
      apiKeyLength: mailConfig.apiKey ? mailConfig.apiKey.length : 0,
      mailTimeoutMs,
      fromAddress: mailConfig.fromAddress,
      fromName: mailConfig.fromName,
      contactInbox: mailConfig.inbox,
    },
  });
}

function logMailFailure(level, { requestId, stage, error }) {
  const safeError = safeProviderDetails(JSON.stringify({
    name: error?.name || "Error",
    message: error?.message || "Unknown email delivery error",
  }), [mailConfig.apiKey, rawApiKey, mailToken]);

  console[level]("Email delivery failed:", {
    requestId,
    stage,
    error: safeError,
    ...(error?.mailDiagnostics ? { diagnostics: error.mailDiagnostics } : {}),
    ...(error?.providerDetails ? { provider: error.providerDetails } : {}),
  });
}

async function sendEmailForStage(sendEmail, message, stage) {
  try {
    await sendEmail(message);
  } catch (error) {
    if (error && typeof error === "object") {
      error.mailStage = stage;
      throw error;
    }
    const stagedError = new Error(String(error || "Unknown email delivery error"));
    stagedError.mailStage = stage;
    throw stagedError;
  }
}

function createRateLimiter(max) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many requests. Please try again later." },
  });
}

export function createApp({ sendEmail = sendZeptoMail } = {}) {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      // Requests with no Origin (curl, server-to-server, health checks) are
      // allowed; browser requests are checked against the allowlist.
      callback(null, !origin || isAllowedOrigin(origin));
    },
  }));
  app.use(express.json({ limit: "16kb" }));

  app.use((request, response, next) => {
    request.requestId = randomUUID();
    request.startedAt = Date.now();
    response.setHeader("X-Request-Id", request.requestId);
    response.on("finish", () => {
      logDebug("http.request", {
        requestId: request.requestId,
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Date.now() - request.startedAt,
      });
    });
    next();
  });

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.post("/api/contact", createRateLimiter(5), async (request, response, next) => {
    const name = cleanString(request.body?.name);
    const email = cleanString(request.body?.email).toLowerCase();
    const phone = cleanString(request.body?.phone);
    const countryCode = cleanString(request.body?.countryCode);
    const enquiry = cleanString(request.body?.enquiry);

    if (
      name.length < 2 ||
      name.length > 100 ||
      /[\u0000-\u001f\u007f]/.test(name) ||
      !validEmail(email) ||
      !e164Pattern.test(phone) ||
      !callingCodePattern.test(countryCode) ||
      enquiry.length < 10 ||
      enquiry.length > 2000
    ) {
      return response.status(400).json({ error: "Please check the form fields and try again." });
    }

    try {
      const safeName = escapeHtml(name);
      const safeEmail = escapeHtml(email);
      const safePhone = escapeHtml(phone);
      const safeEnquiry = escapeHtml(enquiry).replace(/\n/g, "<br>");

      await sendEmailForStage(sendEmail, {
        to: { address: mailConfig.inbox },
        replyTo: { address: email, name },
        subject: "New website enquiry",
        text: `Name: ${name}\nEmail: ${email}\nPhone: ${phone}\n\nEnquiry:\n${enquiry}`,
        html: `<h2>Website enquiry</h2><p><strong>Name:</strong> ${safeName}</p><p><strong>Email:</strong> ${safeEmail}</p><p><strong>Phone:</strong> ${safePhone}</p><p><strong>Enquiry:</strong><br>${safeEnquiry}</p>`,
      }, "contact_notification");

      try {
        await sendEmailForStage(sendEmail, {
          to: { address: email, name },
          replyTo: { address: mailConfig.inbox, name: mailConfig.fromName },
          subject: "We received your message | Patients Flow",
          text: `Hello ${name},\n\nThank you for contacting Patients Flow. We have received your enquiry, and our team will get back to you shortly.\n\nYour submitted enquiry:\n${enquiry}\n\nIf you need to add anything, reply to this email and your message will reach our team.\n\nKind regards,\nPatients Flow\n${mailConfig.inbox}`,
          html: `<div style="margin:0;padding:32px 16px;background-color:#f4f7fa;font-family:Arial,Helvetica,sans-serif;color:#0f1d39"><div style="max-width:600px;margin:0 auto;background-color:#ffffff;border:1px solid #e5eaf0;border-radius:12px;overflow:hidden"><div style="padding:24px 32px;background-color:#0f1d39;color:#ffffff"><p style="margin:0;font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#9ce1dc">Patients Flow</p><h1 style="margin:12px 0 0;font-size:24px;line-height:1.3">We received your enquiry</h1></div><div style="padding:28px 32px"><p style="margin:0 0 16px">Hello ${safeName},</p><p style="margin:0 0 20px;line-height:1.6">Thank you for contacting Patients Flow. Our team has received your message and will get back to you shortly.</p><div style="padding:18px 20px;background-color:#f4f7fa;border-radius:8px"><p style="margin:0 0 10px;font-size:14px;font-weight:bold">Your submitted enquiry</p><p style="margin:0;line-height:1.6;white-space:normal">${safeEnquiry}</p></div><p style="margin:20px 0 0;line-height:1.6">If you need to add anything, reply to this email and your message will reach our team.</p><p style="margin:24px 0 0;line-height:1.6">Kind regards,<br><strong>Patients Flow</strong><br><a href="mailto:${escapeHtml(mailConfig.inbox)}" style="color:#087f79">${escapeHtml(mailConfig.inbox)}</a></p></div></div></div>`,
        }, "contact_acknowledgement");
      } catch (error) {
        logMailFailure("warn", {
          requestId: request.requestId,
          stage: error?.mailStage || "contact_acknowledgement",
          error,
        });
      }

      return response.status(200).json({ message: "Your message has been sent." });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/newsletter", createRateLimiter(3), async (request, response, next) => {
    const email = cleanString(request.body?.email).toLowerCase();

    if (!validEmail(email) || request.body?.consent !== true) {
      return response.status(400).json({ error: "Enter a valid email and agree to receive updates." });
    }

    try {
      const safeEmail = escapeHtml(email);

      await sendEmail({
        to: { address: mailConfig.inbox },
        subject: "New newsletter subscription",
        text: `A visitor subscribed to Patients Flow updates.\n\nEmail: ${email}`,
        html: `<p>A visitor subscribed to Patients Flow updates.</p><p><strong>Email:</strong> ${safeEmail}</p>`,
        replyTo: { address: email },
      });

      await sendEmail({
        to: { address: email },
        subject: "You're subscribed to Patients Flow updates",
        text: "Thanks for subscribing to Patients Flow updates. You can unsubscribe at any time by replying to this email.",
        html: "<p>Thanks for subscribing to Patients Flow updates.</p><p>You can unsubscribe at any time by replying to this email.</p>",
      });

      return response.status(200).json({ message: "Subscription confirmed." });
    } catch (error) {
      return next(error);
    }
  });

  app.use((_request, response) => {
    response.status(404).json({ error: "Not found." });
  });

  app.use((error, request, response, _next) => {
    logMailFailure("error", {
      requestId: request.requestId,
      stage: error?.mailStage || "request",
      error,
    });
    if (response.headersSent) return;
    response.status(500).json({ error: "Unable to process your request right now. Please try again later." });
  });

  return app;
}

// Lightweight startup probe: sends an intentionally invalid (empty) payload.
// The provider validates credentials before the payload, so:
//   401/403  -> auth problem (bad key, wrong data centre)
//   4xx      -> credentials OK, payload was the only problem (expected here)
//   5xx      -> provider/gateway problem
// This never delivers an email, but confirms the key and host are usable.
async function selfCheckZeptoMail() {
  if (!mailClient) {
    console.warn("[mail:selfcheck] skipped", {
      reason: "ZEPTOMAIL_API_KEY is not configured.",
    });
    return;
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(mailUrl, {
      method: "POST",
      headers: {
        Authorization: mailToken,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(mailTimeoutMs),
    });
    const bodyText = await response.text().catch(() => "");
    const summary = {
      endpoint: mailUrl,
      httpStatus: response.status,
      durationMs: Date.now() - startedAt,
      bodySnippet: bodyText.slice(0, 200),
    };

    if (response.status === 401 || response.status === 403) {
      console.error("[mail:selfcheck] AUTH FAILED", {
        ...summary,
        hint: "The API key was rejected. Confirm ZEPTOMAIL_API_KEY matches the data centre in ZEPTOMAIL_HOST (for example cpaas.zoho.com for US, mail.zoho.eu for EU).",
      });
      return;
    }
    if (response.status >= 500) {
      console.error("[mail:selfcheck] PROVIDER ERROR", {
        ...summary,
        hint: "The provider answered 5xx. An empty body here usually means a malformed Authorization header.",
      });
      return;
    }
    console.info("[mail:selfcheck] credentials accepted", summary);
  } catch (error) {
    console.error("[mail:selfcheck] REQUEST FAILED", {
      endpoint: mailUrl,
      durationMs: Date.now() - startedAt,
      name: error?.name || "Error",
      message: error?.message || String(error),
      hint: "Could not reach the ZeptoMail host. Check network access and ZEPTOMAIL_HOST.",
    });
  }
}

if (process.env.NODE_ENV !== "test") {
  logConfiguration();
  createApp().listen(PORT, () => {
    console.log(`Patients Flow mail API listening on port ${PORT}`);
  });
  selfCheckZeptoMail();
}
