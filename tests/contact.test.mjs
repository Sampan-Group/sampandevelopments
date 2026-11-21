import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const fixtures = {
  enquiry: { name: "Test buyer", phone: "+8801929918400", email: "buyer@example.com", project: "Metro Square", interest: "Apartment", message: "Please contact me", abroad: true, consent: true },
  booking: { name: "Test visitor", phone: "+8801929918400", project: "Condominium", visitors: "2", date: "2026-12-15", time: "Morning", pickup: "Yes" },
  "site-visit": { name: "Test visitor", contact: "+8801929918400", project: "Trade Emporium", date: "2026-12-16", message: "Afternoon visit", abroad: false },
};

function loadModule(file, globals) {
  const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, Buffer, Request, Response, URL, AbortSignal, console: { error() {} }, ...globals });
  return exports;
}

function setup({ configured = true, fail = false, reject = false } = {}) {
  const sent = [];
  const configurations = [];
  const route = loadModule("src/app/api/contact/route.ts", {
    process: { env: configured ? { SMTP_HOST: "smtp.example.com", SMTP_USER: "sender@example.com", SMTP_PASS: "test-only", SMTP_FROM: "sender@example.com" } : {} },
    require(name) {
      assert.equal(name, "nodemailer");
      return { createTransport(config) {
        configurations.push(config);
        return { async sendMail(mail) {
          sent.push(mail);
          if (fail) throw new Error("SMTP unavailable");
          return reject ? { accepted: [], rejected: [mail.to] } : { accepted: [mail.to], rejected: [] };
        }, close() {} };
      } };
    },
  });
  const post = (data, origin = "https://example.com") => route.POST(new Request("https://example.com/api/contact", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: typeof data === "string" ? data : JSON.stringify(data),
  }));
  return { sent, configurations, post };
}

for (const [type, fields] of Object.entries(fixtures)) {
  test(`${type}: sends all fields to the fixed recipient`, async () => {
    const { post, sent, configurations } = setup();
    const response = await post({ type, ...fields, to: "attacker@example.com" });
    assert.equal(response.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "info@sampangroup.com.bd");
    assert.equal(sent[0].from.address, "sender@example.com");
    assert.equal(sent[0].replyTo, fields.email);
    for (const value of Object.values(fields)) assert.ok(sent[0].text.includes(typeof value === "boolean" ? value ? "Yes" : "No" : value));
    assert.equal(configurations[0].secure, true);
  });
}

test("invalid and incomplete submissions do not send email", async () => {
  const { post, sent } = setup();
  for (const data of [null, [], "bad json", { type: "toString" }, { type: "enquiry", ...fixtures.enquiry, consent: false }, { type: "enquiry", ...fixtures.enquiry, email: "bad\r\nBcc: test@example.com" }, { type: "booking", ...fixtures.booking, date: "2026-02-30" }, { type: "booking", ...fixtures.booking, visitors: "0" }, { type: "site-visit", ...fixtures["site-visit"], contact: "invalid" }, { type: "enquiry", ...fixtures.enquiry, name: {} }]) {
    assert.equal((await post(data)).status, 400);
  }
  assert.equal(sent.length, 0);
});

test("oversized and cross-origin requests do not send email", async () => {
  const { post, sent } = setup();
  assert.equal((await post("x".repeat(17000))).status, 413);
  assert.equal((await post({ type: "enquiry", ...fixtures.enquiry }, "https://other.example")).status, 403);
  assert.equal(sent.length, 0);
});

test("missing SMTP settings return an error without sending", async () => {
  const { post, sent } = setup({ configured: false });
  assert.equal((await post({ type: "enquiry", ...fixtures.enquiry })).status, 503);
  assert.equal(sent.length, 0);
});

for (const options of [{ fail: true }, { reject: true }]) {
  test(`SMTP ${options.fail ? "failure" : "rejection"} never reports success`, async () => {
    const { post } = setup(options);
    const response = await post({ type: "enquiry", ...fixtures.enquiry });
    assert.equal(response.status, 502);
    assert.ok((await response.json()).error.includes("info@sampangroup.com.bd"));
  });
}

test("the browser submits each form and propagates delivery errors", async () => {
  let lastRequest;
  let fail = false;
  const { submitContact } = loadModule("src/app/lib/submit-contact.ts", {
    fetch: async (url, options) => {
      lastRequest = { url, ...options };
      return Response.json(fail ? { error: "Delivery failed" } : { success: true }, { status: fail ? 502 : 200 });
    },
  });
  for (const [type, fields] of Object.entries(fixtures)) {
    await submitContact(type, fields);
    assert.equal(lastRequest.url, "/api/contact");
    assert.equal(lastRequest.method, "POST");
    assert.deepEqual(JSON.parse(lastRequest.body), { type, ...fields });
  }
  fail = true;
  await assert.rejects(submitContact("enquiry", fixtures.enquiry), /Delivery failed/);
});
