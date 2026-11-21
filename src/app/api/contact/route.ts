import nodemailer from "nodemailer";

const RECIPIENT = "info@sampangroup.com.bd";
const DELIVERY_ERROR = `Unable to send your request. Please try again or email ${RECIPIENT}.`;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const PHONE = /^[+\d\s()-]{6,40}$/;

const forms = {
  enquiry: {
    title: "Website enquiry",
    required: ["name", "phone", "interest"],
    fields: {
      name: "Full name", phone: "Phone / WhatsApp", email: "Email",
      project: "Project", interest: "Interest", message: "Message",
      abroad: "Lives abroad", consent: "Contact consent",
    },
  },
  booking: {
    title: "Contact page site-visit booking",
    required: ["name", "phone", "project", "date"],
    fields: {
      name: "Full name", phone: "Phone / WhatsApp", project: "Project",
      visitors: "Visitors", date: "Preferred date", time: "Preferred time", pickup: "Pick-up needed",
    },
  },
  "site-visit": {
    title: "Homepage site-visit request",
    required: ["name", "contact", "project", "date"],
    fields: {
      name: "Full name", contact: "Phone / WhatsApp", project: "Project",
      date: "Preferred date", message: "Message", abroad: "Lives abroad",
    },
  },
} as const;

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }

  // Read a bounded stream rather than trusting Content-Length.
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "Missing form data." }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16384) {
      await reader.cancel();
      return Response.json({ error: "Your message is too long." }, { status: 413 });
    }
    chunks.push(value);
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
  } catch {
    return Response.json({ error: "Invalid form data." }, { status: 400 });
  }

  if (typeof data.type !== "string" || !Object.hasOwn(forms, data.type)) {
    return Response.json({ error: "Unknown form." }, { status: 400 });
  }
  const form = forms[data.type as keyof typeof forms];
  const values: Record<string, string> = {};
  for (const key of Object.keys(form.fields)) {
    const value = data[key];
    const booleanField = key === "abroad" || key === "consent";
    if (value !== undefined && (booleanField ? typeof value !== "boolean" : typeof value !== "string")) {
      return Response.json({ error: "Invalid form field." }, { status: 400 });
    }
    values[key] = typeof value === "boolean" ? (value ? "Yes" : "No") : typeof value === "string" ? value.trim() : "";
    if (values[key].length > (key === "message" ? 5000 : 300)) {
      return Response.json({ error: "A form field is too long." }, { status: 400 });
    }
  }
  if (form.required.some(key => !values[key]) ||
      !PHONE.test(values.phone || values.contact || "") ||
      (values.email && !EMAIL.test(values.email)) ||
      (data.type === "enquiry" && data.consent !== true) ||
      (data.type !== "enquiry" && (!/^\d{4}-\d{2}-\d{2}$/.test(values.date) ||
        Number.isNaN(Date.parse(values.date)) || new Date(values.date).toISOString().slice(0, 10) !== values.date)) ||
      (data.type === "booking" && (!/^[1-9]\d{0,2}$/.test(values.visitors) ||
        !["Morning", "Afternoon"].includes(values.time) || !["Yes", "No"].includes(values.pickup)))) {
    return Response.json({ error: "Please check the required fields and try again." }, { status: 400 });
  }

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  const port = Number(SMTP_PORT || 465);
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_FROM ||
      !EMAIL.test(SMTP_FROM) || !Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("Contact email: SMTP configuration is missing or invalid.");
    return Response.json({ error: DELIVERY_ERROR }, { status: 503 });
  }

  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  try {
    const result = await transport.sendMail({
      from: { name: "Sampan Development Website", address: SMTP_FROM },
      to: RECIPIENT,
      replyTo: values.email || undefined,
      subject: `Sampan Development: ${form.title}`,
      text: [form.title, "", ...Object.entries(form.fields).map(([key, label]) =>
        `${label}: ${values[key] || "Not provided"}`)].join("\n"),
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    if (!result.accepted?.length || result.rejected?.length) throw new Error("Recipient not accepted");
    return Response.json({ success: true });
  } catch {
    console.error("Contact email: SMTP delivery failed.");
    return Response.json({ error: DELIVERY_ERROR }, { status: 502 });
  } finally {
    transport.close();
  }
}
