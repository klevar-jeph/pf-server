import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { SendMailClient } from "zeptomail";

process.env.NODE_ENV = "test";
process.env.ZEPTOMAIL_API_KEY = "test-zeptomail-key";
const { createApp, preserveProviderHttpStatus } = await import("../src/server.js");

let sentEmails = [];
let server;
let baseUrl;

before(async () => {
  server = createApp({
    sendEmail: async (message) => {
      sentEmails.push(message);
    },
  }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("health endpoint confirms the API is running", async () => {
  const response = await fetch(`${baseUrl}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("CORS echoes allowed origins and preflight succeeds", async () => {
  const allowed = [
    "https://patientsflow.co.uk",
    "https://app.patientsflow.co.uk",
    ...(process.env.FRONTEND_ORIGINS?.split(",").map((origin) => origin.trim()) ?? []),
  ];

  for (const origin of allowed) {
    const preflight = await fetch(`${baseUrl}/api/contact`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(preflight.status, 204, `preflight should succeed for ${origin}`);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);

    const simple = await fetch(`${baseUrl}/health`, { headers: { Origin: origin } });
    assert.equal(simple.headers.get("access-control-allow-origin"), origin);
  }
});

test("CORS matches configured origins case-insensitively and without trailing slashes", async () => {
  const preflight = await fetch(`${baseUrl}/api/newsletter`, {
    method: "OPTIONS",
    headers: {
      Origin: "HTTPS://APP.PATIENTSFLOW.CO.UK/",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });

  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "HTTPS://APP.PATIENTSFLOW.CO.UK/",
  );
});

test("CORS does not echo an origin outside the allowlist", async () => {
  const preflight = await fetch(`${baseUrl}/api/contact`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://evil.example.com",
      "Access-Control-Request-Method": "POST",
    },
  });

  assert.equal(preflight.headers.get("access-control-allow-origin"), null);
});

test("normalizeApiKey strips a stray auth prefix so it is never sent twice", async () => {
  const { normalizeApiKey } = await import("../src/server.js");

  // The bug: pasting the dashboard value with its "Zoho-enczapikey " prefix,
  // then sending the prefix again, made Zoho reply 500 with an empty body.
  assert.equal(normalizeApiKey("Zoho-enczapikey abc123"), "abc123");
  assert.equal(normalizeApiKey("zoho-enczapikey abc123"), "abc123");
  assert.equal(normalizeApiKey("abc123"), "abc123");
  assert.equal(normalizeApiKey("  abc123  "), "abc123");
  assert.equal(normalizeApiKey(""), "");
  assert.equal(normalizeApiKey(undefined), "");
  // Idempotent: running it again on an already-bare key changes nothing.
  assert.equal(normalizeApiKey(normalizeApiKey("Zoho-enczapikey abc123")), "abc123");
});

test("ZeptoMail SDK handles empty error bodies without an unhandled JSON rejection", async () => {
  const client = new SendMailClient({
    url: "https://cpaas.zoho.com/v1.1/email",
    token: "Zoho-enczapikey test-token",
  });
  preserveProviderHttpStatus(client);

  const response = {
    ok: false,
    status: 500,
    statusText: "Internal Server Error",
    async json() {
      throw new SyntaxError("Unexpected end of JSON input");
    },
  };

  await assert.rejects(client.httpRequest(Promise.resolve(response)), (error) =>
    error.statusCode === 500 &&
    error.statusText === "Internal Server Error" &&
    error.message === "Provider returned an empty or non-JSON error response." &&
    typeof error.json === "undefined",
  );
});

test("contact form sends an inbox email and an acknowledgement", async () => {
  sentEmails = [];
  const response = await fetch(`${baseUrl}/api/contact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Jane Smith",
      email: "jane@example.com",
      phone: "+447123456789",
      countryCode: "+44",
      enquiry: "<script>alert(1)</script>\nI would like to learn more.",
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(sentEmails.length, 2);
  assert.equal(sentEmails[0].to.address, "contact@app.patientsflow.co.uk");
  assert.equal(sentEmails[0].replyTo.address, "jane@example.com");
  assert.match(sentEmails[0].html, /&lt;script&gt;/);
  assert.match(sentEmails[0].html, /\+447123456789/);
  assert.equal(sentEmails[1].to.address, "jane@example.com");
  assert.equal(sentEmails[1].replyTo.address, "contact@app.patientsflow.co.uk");
  assert.match(sentEmails[1].subject, /We received your message/);
  assert.match(sentEmails[1].html, /We received your enquiry/);
  assert.match(sentEmails[1].html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(sentEmails[1].html, /<script>/);
  assert.match(sentEmails[1].text, /I would like to learn more\./);
});

test("contact form rejects header-injection characters in names", async () => {
  sentEmails = [];
  const response = await fetch(`${baseUrl}/api/contact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Jane\r\nBcc: attacker@example.com",
      email: "jane@example.com",
      phone: "+447123456789",
      countryCode: "+44",
      enquiry: "I would like to learn more.",
    }),
  });

  assert.equal(response.status, 400);
  assert.equal(sentEmails.length, 0);
});

test("invalid contact form input is rejected without sending email", async () => {
  sentEmails = [];
  const response = await fetch(`${baseUrl}/api/contact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "J", email: "invalid", enquiry: "Short" }),
  });

  assert.equal(response.status, 400);
  assert.equal(sentEmails.length, 0);
});

test("contact form rejects non-E.164 phone numbers", async () => {
  sentEmails = [];
  const response = await fetch(`${baseUrl}/api/contact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Jane Smith",
      email: "jane@example.com",
      phone: "07123 456789",
      countryCode: "+44",
      enquiry: "I would like to learn more.",
    }),
  });

  assert.equal(response.status, 400);
  assert.equal(sentEmails.length, 0);
});

test("newsletter requires explicit consent and confirms a valid subscription", async () => {
  sentEmails = [];
  const denied = await fetch(`${baseUrl}/api/newsletter`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "jane@example.com", consent: false }),
  });
  assert.equal(denied.status, 400);
  assert.equal(sentEmails.length, 0);

  const accepted = await fetch(`${baseUrl}/api/newsletter`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "jane@example.com", consent: true }),
  });

  assert.equal(accepted.status, 200);
  assert.equal(sentEmails.length, 2);
  assert.equal(sentEmails[0].to.address, "contact@app.patientsflow.co.uk");
  assert.equal(sentEmails[1].to.address, "jane@example.com");
});

test("contact notification failures log the delivery stage and keep the response generic", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const loggedErrors = [];
  const sendEmail = async () => {
    const error = new Error("ZeptoMail email request failed.");
    error.providerDetails = {
      response: {
        statusCode: 500,
        error_code: "INVALID_AGENT_KEY",
        message: "Provider rejected request for [redacted email].",
      },
    };
    throw error;
  };
  console.error = (...args) => loggedErrors.push(args);

  try {
    const appServer = createApp({ sendEmail }).listen(0);
    await new Promise((resolve) => appServer.once("listening", resolve));
    const appUrl = `http://127.0.0.1:${appServer.address().port}`;
    const response = await originalFetch(`${appUrl}/api/contact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Jane Smith",
        email: "jane@example.com",
        phone: "+447123456789",
        countryCode: "+44",
        enquiry: "Private enquiry details should not appear in logs.",
      }),
    });
    const responseBody = await response.json();
    await new Promise((resolve, reject) => {
      appServer.close((error) => (error ? reject(error) : resolve()));
    });

    assert.equal(response.status, 500);
    assert.match(response.headers.get("x-request-id"), /^[\da-f-]{36}$/i);
    assert.deepEqual(responseBody, {
      error: "Unable to process your request right now. Please try again later.",
    });
    assert.equal(loggedErrors.length, 1);

    const logOutput = JSON.stringify(loggedErrors[0]);
    assert.match(logOutput, /INVALID_AGENT_KEY/);
    assert.match(logOutput, /contact_notification/);
    assert.match(logOutput, /statusCode/);
    assert.doesNotMatch(logOutput, /jane@example\.com|test-zeptomail-key|Private enquiry details/);
  } finally {
    console.error = originalConsoleError;
  }
});

test("failed visitor acknowledgement does not report an accepted enquiry as failed", async () => {
  const originalConsoleWarn = console.warn;
  const loggedWarnings = [];
  let appServer;
  let sendCount = 0;
  const sendEmail = async () => {
    sendCount += 1;
    if (sendCount === 2) {
      const error = new Error("ZeptoMail email request failed.");
      error.providerDetails = {
        response: { statusCode: 500, message: "Temporary provider failure" },
      };
      throw error;
    }
  };
  console.warn = (...args) => loggedWarnings.push(args);

  try {
    appServer = createApp({ sendEmail }).listen(0);
    await new Promise((resolve) => appServer.once("listening", resolve));
    const appUrl = `http://127.0.0.1:${appServer.address().port}`;
    const response = await fetch(`${appUrl}/api/contact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Jane Smith",
        email: "jane@example.com",
        phone: "+447123456789",
        countryCode: "+44",
        enquiry: "Please send more information.",
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      message: "Your message has been sent.",
    });
    assert.equal(sendCount, 2);
    assert.equal(loggedWarnings.length, 1);
    assert.match(JSON.stringify(loggedWarnings[0]), /contact_acknowledgement/);
  } finally {
    console.warn = originalConsoleWarn;
    if (appServer?.listening) {
      await new Promise((resolve, reject) => {
        appServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
});
