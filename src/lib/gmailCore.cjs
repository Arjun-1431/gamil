const dotenv = require("dotenv");
const { google } = require("googleapis");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

dotenv.config();

const DATA_DIR = path.join(process.cwd(), "data");
const JOB_STORE_PATH = path.join(DATA_DIR, "job-followups.json");
const FIFTEEN_HOURS_MS = 15 * 60 * 60 * 1000;

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

const INBOX_CATEGORY_LABELS = {
  primary: "CATEGORY_PERSONAL",
  promotions: "CATEGORY_PROMOTIONS",
  social: "CATEGORY_SOCIAL",
  updates: "CATEGORY_UPDATES",
  forums: "CATEGORY_FORUMS",
};

const READ_ONLY_FS_ERROR_CODES = new Set(["EROFS", "EACCES", "EPERM"]);
const RECENT_INCOMING_MAIL_GRACE_MS = 5 * 60 * 1000;
const INCOMING_MAIL_WATCH_STARTED_AT_MS = Date.now();
const seenIncomingMailByScope = new Map();

function getOAuthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } =
    process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error("Google OAuth env vars are not configured.");
  }

  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

function getAuthedGmail(req) {
  if (!req.session.googleTokens) {
    const error = new Error("Gmail is not connected.");
    error.statusCode = 401;
    throw error;
  }

  const auth = getOAuthClient();
  auth.setCredentials(req.session.googleTokens);
  auth.on("tokens", (tokens) => {
    req.session.googleTokens = { ...req.session.googleTokens, ...tokens };
  });

  return google.gmail({ version: "v1", auth });
}

function getGmailFromTokens(tokens) {
  const auth = getOAuthClient();
  auth.setCredentials(tokens);
  return google.gmail({ version: "v1", auth });
}

function getHeader(headers = [], name) {
  const expectedName = name.toLowerCase();
  return (
    headers.find((header) => header.name.toLowerCase() === expectedName)?.value ||
    ""
  );
}

function decodeBase64Url(value = "") {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function findBody(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  for (const part of payload.parts || []) {
    const body = findBody(part);
    if (body) return body;
  }
  return payload.body?.data ? decodeBase64Url(payload.body.data) : "";
}

function findAttachments(payload, attachments = []) {
  if (!payload) return attachments;
  if (payload.filename && payload.body?.attachmentId) {
    attachments.push({
      id: payload.body.attachmentId,
      filename: payload.filename,
      mimeType: payload.mimeType || "application/octet-stream",
      size: payload.body.size || 0,
    });
  }

  for (const part of payload.parts || []) {
    findAttachments(part, attachments);
  }

  return attachments;
}

function normalizeMessage(message) {
  const headers = message.payload?.headers || [];
  const labels = message.labelIds || [];
  const date = getHeader(headers, "Date");

  return {
    id: message.id,
    threadId: message.threadId,
    subject: getHeader(headers, "Subject") || "(No subject)",
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    snippet: message.snippet || "",
    date,
    internalDate: message.internalDate || null,
    sortTime: Number(message.internalDate || Date.parse(date) || 0),
    labels,
    unread: labels.includes("UNREAD"),
  };
}

function normalizeFullMessage(message) {
  const headers = message.payload?.headers || [];
  return {
    ...normalizeMessage(message),
    cc: getHeader(headers, "Cc"),
    bcc: getHeader(headers, "Bcc"),
    replyTo: getHeader(headers, "Reply-To"),
    messageId: getHeader(headers, "Message-ID"),
    references: getHeader(headers, "References"),
    body: findBody(message.payload),
    attachments: findAttachments(message.payload),
    internalDate: message.internalDate,
  };
}

function getIncomingMailTime(email) {
  const internalDate = Number(email?.internalDate || 0);
  if (Number.isFinite(internalDate) && internalDate > 0) return internalDate;

  const parsedDate = Date.parse(email?.date || "");
  return Number.isFinite(parsedDate) ? parsedDate : 0;
}

function getSeenIncomingMailScope(scope) {
  const seen = seenIncomingMailByScope.get(scope);
  if (seen) return seen;

  const nextSeen = new Set();
  seenIncomingMailByScope.set(scope, nextSeen);
  return nextSeen;
}

function trackIncomingMail(email, source = "unknown", scope = source) {
  if (!email?.id) return false;

  const seen = getSeenIncomingMailScope(scope);
  if (seen.has(email.id)) return false;

  seen.add(email.id);
  console.log("[IncomingMail] NEW", {
    source,
    scope,
    id: email.id,
    threadId: email.threadId,
    from: email.from,
    to: email.to,
    subject: email.subject,
    date: email.date,
    internalDate: email.internalDate,
    unread: email.unread,
    labels: email.labels,
    snippet: email.snippet,
  });
  return true;
}

function trackIncomingMailBatch(emails, source = "unknown", scope = source) {
  const seen = getSeenIncomingMailScope(scope);
  const newEmails = [];

  for (const email of emails) {
    if (!email?.id) continue;

    const mailTime = getIncomingMailTime(email);
    const recentlyArrived =
      mailTime >= Date.now() - RECENT_INCOMING_MAIL_GRACE_MS;
    const arrivedAfterWatchStarted =
      mailTime > INCOMING_MAIL_WATCH_STARTED_AT_MS;

    if (!arrivedAfterWatchStarted && !recentlyArrived) {
      seen.add(email.id);
      continue;
    }

    if (trackIncomingMail(email, source, scope)) {
      newEmails.push(email);
    }
  }

  return newEmails;
}

function stripHtml(value = "") {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSearchQuery(query = {}) {
  const parts = [];
  if (query.subject) parts.push(`subject:(${query.subject})`);
  if (query.sender) parts.push(`from:(${query.sender})`);
  if (query.date) {
    const selected = new Date(`${query.date}T00:00:00.000Z`);
    selected.setUTCDate(selected.getUTCDate() + 1);
    const nextDay = selected.toISOString().slice(0, 10);
    parts.push(`after:${query.date} before:${nextDay}`);
  }
  if (query.q) parts.push(query.q);
  return parts.join(" ");
}

async function listMessages(req, labelIds) {
  const gmail = getAuthedGmail(req);
  const maxResults = Math.min(Number(req.query.limit || 20), 50);
  const isInboxRequest = labelIds.includes("INBOX");

  const listResponse = await gmail.users.messages.list({
    userId: "me",
    labelIds,
    maxResults,
    pageToken: req.query.pageToken,
    q: buildSearchQuery(req.query),
  });

  const messages = listResponse.data.messages || [];
  const hydrated = await Promise.all(
    messages.map(async ({ id }) => {
      const message = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "To", "Date"],
      });
      return normalizeMessage(message.data);
    })
  );

  const sorted = hydrated.sort((a, b) => (b.sortTime || 0) - (a.sortTime || 0));

  if (isInboxRequest) {
    trackIncomingMailBatch(
      sorted,
      "gmail/inbox",
      `incoming:${req.session?.gmailEmail || "connected"}`
    );
  }

  return {
    emails: sorted,
    nextPageToken: listResponse.data.nextPageToken || null,
    resultSizeEstimate: listResponse.data.resultSizeEstimate || 0,
  };
}

function cleanEmailHeader(value = "") {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

function createRawEmail({ to, subject, body, cc, bcc, inReplyTo, references }) {
  const safeBody =
    body && String(body).trim()
      ? String(body)
      : "<p>Hello,</p><p>Thank you for your email. I have received your message and will get back to you soon.</p><p>Best regards,<br/>Arjun Singh</p>";

  const lines = [
    `To: ${cleanEmailHeader(to)}`,
    cc ? `Cc: ${cleanEmailHeader(cc)}` : null,
    bcc ? `Bcc: ${cleanEmailHeader(bcc)}` : null,
    `Subject: ${cleanEmailHeader(subject || "")}`,
    inReplyTo ? `In-Reply-To: ${cleanEmailHeader(inReplyTo)}` : null,
    references ? `References: ${cleanEmailHeader(references)}` : null,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    safeBody,
  ].filter((line) => line !== null);

  return Buffer.from(lines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (error) {
    if (!READ_ONLY_FS_ERROR_CODES.has(error.code)) {
      throw error;
    }
  }
}

function readJobStore() {
  ensureDataDir();
  if (!fs.existsSync(JOB_STORE_PATH)) {
    return { accounts: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(JOB_STORE_PATH, "utf8"));
  } catch {
    return { accounts: {} };
  }
}

function writeJobStore(store) {
  ensureDataDir();
  try {
    fs.writeFileSync(JOB_STORE_PATH, JSON.stringify(store, null, 2));
  } catch (error) {
    if (READ_ONLY_FS_ERROR_CODES.has(error.code)) {
      console.warn("Job store is read-only in this runtime; skipping file write.");
      return false;
    }
    throw error;
  }
  return true;
}

function getAccount(store, emailAddress) {
  if (!store.accounts[emailAddress]) {
    store.accounts[emailAddress] = {
      automationEnabled: false,
      encryptedTokens: null,
      applications: {},
      importantInbox: {},
      jobReplies: {},
      inboxAutoReplies: {},
    };
  }
  if (!store.accounts[emailAddress].importantInbox) {
    store.accounts[emailAddress].importantInbox = {};
  }
  if (!store.accounts[emailAddress].jobReplies) {
    store.accounts[emailAddress].jobReplies = {};
  }
  if (!store.accounts[emailAddress].inboxAutoReplies) {
    store.accounts[emailAddress].inboxAutoReplies = {};
  }
  return store.accounts[emailAddress];
}

function getEncryptionKey() {
  return crypto
    .createHash("sha256")
    .update(process.env.SESSION_SECRET || "change-me-in-env")
    .digest();
}

function encryptTokens(tokens) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(tokens), "utf8"),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    value: encrypted.toString("base64"),
  };
}

function decryptTokens(payload) {
  if (!payload) return null;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(payload.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.value, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8"));
}

function extractEmailAddress(value = "") {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] || value).split(",")[0].trim().toLowerCase();
}

function looksLikeJobApplication(email) {
  const text = `${email.subject || ""} ${email.snippet || ""} ${stripHtml(
    email.body || ""
  )}`.toLowerCase();
  return /application|applying|resume|cv|web developer|developer position|job|hiring manager|position/.test(
    text
  );
}

function inferJobReplyStatus(email) {
  const text = `${email.subject || ""} ${email.snippet || ""} ${stripHtml(
    email.body || ""
  )}`.toLowerCase();

  if (/not selected|not shortlisted|unfortunately|regret|reject/.test(text)) {
    return { status: "rejected", reason: "The reply indicates rejection." };
  }
  if (/interview|scheduled|schedule|meeting|call|round/.test(text)) {
    return {
      status: "interview_requested",
      reason: "The reply includes interview scheduling or next-round details.",
    };
  }
  if (/selected|shortlisted|congratulations|pleased to inform/.test(text)) {
    return {
      status: /shortlisted/.test(text) ? "shortlisted" : "selected",
      reason: "The reply indicates selection or shortlisting.",
    };
  }
  if (/next steps|application update|thank you for your interest/.test(text)) {
    return { status: "replied", reason: "The recruiter replied to the application." };
  }
  return { status: "other", reason: "" };
}

function shouldSkipInboxAutoReply(email, accountEmail) {
  const senderEmail = extractEmailAddress(email.from);
  if (!senderEmail || senderEmail === accountEmail.toLowerCase()) return true;
  if (/no-?reply|do-?not-?reply|mailer-daemon|postmaster/.test(senderEmail)) {
    return true;
  }
  return false;
}

function buildInboxAutoReply(email) {
  const subject = email.subject || "Your email";
  const text = stripHtml(`${email.subject || ""}\n${email.snippet || ""}\n${email.body || ""}`);
  const lowerText = text.toLowerCase();
  const isInterview =
    /interview|scheduled|schedule|meeting|call|round|venue/.test(lowerText);
  const isShortlisted =
    /shortlisted|selected|pleased to inform|congratulations/.test(lowerText);
  const isOffer = /offer letter|job offer|offer of employment/.test(lowerText);
  const timeMatch = text.match(/\b(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:AM|PM|am|pm)\b/);
  const mentionedTime = timeMatch?.[0];

  let bodyHtml =
    "<p>Hello,</p><p>Thank you for your email. I have received your message and will get back to you soon.</p><p>Best regards,<br/>Arjun Singh</p>";

  if (isInterview) {
    bodyHtml = [
      "<p>Hello,</p>",
      `<p>Thank you for the update. I am glad to hear that I have been ${
        isShortlisted ? "shortlisted" : "considered"
      } for the interview.</p>`,
      `<p>I confirm my availability for the interview${
        mentionedTime ? ` at ${mentionedTime}` : ""
      }. Please share any further details or instructions if required.</p>`,
      "<p>Best regards,<br/>Arjun Singh</p>",
    ].join("");
  } else if (isOffer) {
    bodyHtml = [
      "<p>Hello,</p>",
      "<p>Thank you for sharing the offer details. I appreciate the opportunity and will review the information carefully.</p>",
      "<p>I will get back to you soon if any clarification is needed.</p>",
      "<p>Best regards,<br/>Arjun Singh</p>",
    ].join("");
  } else if (isShortlisted) {
    bodyHtml = [
      "<p>Hello,</p>",
      "<p>Thank you for the update. I am pleased to hear that I have been shortlisted.</p>",
      "<p>Please let me know the next steps and any details I should prepare.</p>",
      "<p>Best regards,<br/>Arjun Singh</p>",
    ].join("");
  }

  return {
    subject: subject.toLowerCase().startsWith("re:") ? subject : `Re: ${subject}`,
    bodyHtml,
  };
}

async function generateInboxAutoReplyEmail(email) {
  const fallback = buildInboxAutoReply(email);

  const result = await callNvidiaJson(
    [
      {
        role: "system",
        content:
          "Return strict JSON only. Write a concise, polite email reply according to the received email. If it mentions interview, shortlist, selection, offer, schedule, time, or venue, acknowledge those details naturally and confirm interest/availability. Do not write a generic received-message reply unless the email has no actionable context. Do not invent facts.",
      },
      {
        role: "user",
        content: JSON.stringify({
          expectedSchema: { subject: "string", bodyHtml: "string" },
          originalSubject: email.subject,
          from: email.from,
          to: email.to,
          snippet: email.snippet,
          body: stripHtml(email.body || "").slice(0, 2200),
        }),
      },
    ],
    fallback
  );

  return {
    subject: result.subject || fallback.subject,
    bodyHtml: result.bodyHtml || fallback.bodyHtml,
  };
}

function logInboxAutoReply(message, details, diagnostics) {
  if (diagnostics) {
    diagnostics.push({
      at: new Date().toISOString(),
      message,
      details: details === undefined ? null : details,
    });
  }
}

async function callNvidiaJson(messages, fallback) {
  if (!process.env.NVIDIA_API_KEY) {
    console.warn("NVIDIA_API_KEY is not configured, using fallback");
    return fallback;
  }

  const controller = new AbortController();
  const nvidiaTimeoutMs = Math.max(
    5000,
    Math.min(Number(process.env.NVIDIA_TIMEOUT_MS || 25000), 60000)
  );
  const timeoutId = setTimeout(() => controller.abort(), nvidiaTimeoutMs);

  try {
    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.NVIDIA_MODEL || "meta/llama-3.1-70b-instruct",
        temperature: 0.1,
        max_tokens: 350,
        messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`NVIDIA API failed with status ${response.status}, using fallback`);
      return fallback;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;

    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return fallback;
    }
  } catch (error) {
    if (error.name === "AbortError") {
      console.warn(
        `NVIDIA API request timed out after ${nvidiaTimeoutMs}ms, using fallback`
      );
      return fallback;
    }
    console.warn(`NVIDIA API request failed, using fallback: ${error.message}`);
    return fallback;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function classifySentJobEmail(email) {
  const fallback = {
    isJobApplication: false,
    company: "",
    role: "",
    confidence: 0,
  };

  return callNvidiaJson(
    [
      {
        role: "system",
        content:
          "Return strict JSON only. Detect whether a sent email is a job application email.",
      },
      {
        role: "user",
        content: JSON.stringify({
          expectedSchema: {
            isJobApplication: "boolean",
            company: "string",
            role: "string",
            confidence: "number 0-1",
          },
          subject: email.subject,
          to: email.to,
          snippet: email.snippet,
          body: stripHtml(email.body).slice(0, 2500),
        }),
      },
    ],
    fallback
  );
}

async function analyzeThreadOutcome(threadMessages, applicantEmail) {
  const replies = threadMessages.filter((message) => {
    const from = extractEmailAddress(message.from);
    return from && from !== applicantEmail.toLowerCase();
  });

  if (!replies.length) {
    return { status: "no_response", reason: "No recruiter reply found." };
  }

  return callNvidiaJson(
    [
      {
        role: "system",
        content:
          "Return strict JSON only. Analyze recruiter replies to a job application. Status must be one of replied, rejected, selected, interview_requested, no_response.",
      },
      {
        role: "user",
        content: JSON.stringify({
          expectedSchema: {
            status: "replied|rejected|selected|interview_requested|no_response",
            reason: "short string",
          },
          replies: replies.map((message) => ({
            from: message.from,
            date: message.date,
            subject: message.subject,
            body: stripHtml(message.body || message.snippet).slice(0, 2000),
          })),
        }),
      },
    ],
    { status: "replied", reason: "Recruiter replied." }
  );
}

async function generateFollowUpEmail(application) {
  const fallbackBody = `<p>Hello,</p><p>I hope you are doing well. I wanted to follow up on my application for ${application.role || "the role"}. I remain interested in the opportunity and would be happy to discuss my fit for the position or schedule an interview at your convenience.</p><p>Thank you for your time.</p>`;

  const result = await callNvidiaJson(
    [
      {
        role: "system",
        content:
          "Return strict JSON only. Write a concise, polite job application follow-up email asking for an update and interview scheduling availability.",
      },
      {
        role: "user",
        content: JSON.stringify({
          expectedSchema: { subject: "string", bodyHtml: "string" },
          company: application.company,
          role: application.role,
          originalSubject: application.subject,
          recipient: application.to,
        }),
      },
    ],
    {
      subject: `Follow up: ${application.subject}`,
      bodyHtml: fallbackBody,
    }
  );

  return {
    subject: result.subject || `Follow up: ${application.subject}`,
    bodyHtml: result.bodyHtml || fallbackBody,
  };
}

async function classifyImportantInboxEmail(email) {
  const fallback = {
    isImportant: false,
    category: "other",
    title: "",
    reason: "",
    confidence: 0,
  };

  return callNvidiaJson(
    [
      {
        role: "system",
        content:
          "Return strict JSON only. Classify whether this inbox email is personally important. Important categories are job_response, selection, offer_letter, interview, achievement, deadline, financial, urgent, other_important, other.",
      },
      {
        role: "user",
        content: JSON.stringify({
          expectedSchema: {
            isImportant: "boolean",
            category:
              "job_response|selection|offer_letter|interview|achievement|deadline|financial|urgent|other_important|other",
            title: "short string",
            reason: "short English explanation",
            confidence: "number 0-1",
          },
          subject: email.subject,
          from: email.from,
          to: email.to,
          snippet: email.snippet,
          body: stripHtml(email.body).slice(0, 2600),
        }),
      },
    ],
    fallback
  );
}

async function classifyJobReplyEmail(email) {
  const fallback = {
    isJobRelatedReply: false,
    status: "other",
    company: "",
    role: "",
    interviewDate: "",
    reason: "",
    confidence: 0,
  };

  return callNvidiaJson(
    [
      {
        role: "system",
        content:
          "Return strict JSON only. Analyze if this inbox email is a reply/status update for a job application. Status must be selected, interview_requested, shortlisted, rejected, replied, or other.",
      },
      {
        role: "user",
        content: JSON.stringify({
          expectedSchema: {
            isJobRelatedReply: "boolean",
            status:
              "selected|interview_requested|shortlisted|rejected|replied|other",
            company: "string",
            role: "string",
            interviewDate: "string if present",
            reason: "short English explanation",
            confidence: "number 0-1",
          },
          subject: email.subject,
          from: email.from,
          replyTo: email.replyTo,
          snippet: email.snippet,
          body: stripHtml(email.body).slice(0, 3000),
        }),
      },
    ],
    fallback
  );
}

async function generateJobReplyEmail(jobReply) {
  const fallback = {
    subject: jobReply.subject?.toLowerCase().startsWith("re:")
      ? jobReply.subject
      : `Re: ${jobReply.subject}`,
    bodyHtml: `<p>Hello,</p><p>Thank you for your email. I appreciate the update and I am interested in moving forward. Please let me know the next steps and a suitable time for the interview or discussion.</p><p>Best regards,<br/>Arjun Singh</p>`,
  };

  const result = await callNvidiaJson(
    [
      {
        role: "system",
        content:
          "Return strict JSON only. Write a concise, professional reply to a recruiter/job email. Be polite, confident, and ask for next steps or interview schedule when relevant.",
      },
      {
        role: "user",
        content: JSON.stringify({
          expectedSchema: { subject: "string", bodyHtml: "string" },
          status: jobReply.status,
          company: jobReply.company,
          role: jobReply.role,
          interviewDate: jobReply.interviewDate,
          originalSubject: jobReply.subject,
          recruiterFrom: jobReply.from,
          reason: jobReply.reason,
        }),
      },
    ],
    fallback
  );

  return {
    subject: result.subject || fallback.subject,
    bodyHtml: result.bodyHtml || fallback.bodyHtml,
  };
}

async function buildSentJobApplicationIndex(gmail, account, limit = 100) {
  const sentResponse = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["SENT"],
    maxResults: Math.min(Number(limit || 100), 100),
    q: '("application" OR "applying" OR "resume" OR "cv" OR "job" OR "position" OR "web developer" OR "hiring manager")',
  });
  const threadIds = new Set();
  const recipientEmails = new Set();
  const applicationsByThread = {};

  for (const item of sentResponse.data.messages || []) {
    const sentMessage = await getFullMessage(gmail, item.id);
    const previous = account.applications[sentMessage.id] || {};
    let classification = {
      isJobApplication: Boolean(previous.id),
      company: previous.company || "",
      role: previous.role || "",
      confidence: previous.confidence || 0,
    };

    if (!classification.isJobApplication) {
      try {
        classification = await classifySentJobEmail(sentMessage);
      } catch {
        classification = {
          isJobApplication: looksLikeJobApplication(sentMessage),
          company: "",
          role: "",
          confidence: looksLikeJobApplication(sentMessage) ? 0.7 : 0,
        };
      }
    }

    const isJobApplication =
      classification.isJobApplication ||
      classification.confidence >= 0.55 ||
      looksLikeJobApplication(sentMessage);

    if (!isJobApplication) continue;

    const recipientEmail = extractEmailAddress(sentMessage.to);
    const application = {
      id: sentMessage.id,
      threadId: sentMessage.threadId,
      subject: sentMessage.subject,
      to: sentMessage.to,
      recipientEmail,
      date: sentMessage.date,
      company: classification.company || previous.company || "",
      role: classification.role || previous.role || "",
      confidence: Math.max(classification.confidence || 0, previous.confidence || 0),
      status: previous.status || "no_response",
      reason: previous.reason || "Waiting for recruiter response.",
      stopFollowUps: previous.stopFollowUps || false,
      lastAnalyzedAt: previous.lastAnalyzedAt || null,
      lastFollowUpAt: previous.lastFollowUpAt || null,
      followUpCount: previous.followUpCount || 0,
    };

    account.applications[sentMessage.id] = application;
    if (sentMessage.threadId) {
      threadIds.add(sentMessage.threadId);
      applicationsByThread[sentMessage.threadId] = application;
    }
    if (recipientEmail) recipientEmails.add(recipientEmail);
  }

  return { threadIds, recipientEmails, applicationsByThread };
}

async function analyzeJobReplies(req) {
  const gmail = getAuthedGmail(req);
  const profile = await gmail.users.getProfile({ userId: "me" });
  const store = readJobStore();
  const account = getAccount(store, profile.data.emailAddress);
  account.encryptedTokens = encryptTokens(req.session.googleTokens);
  const sentIndex = await buildSentJobApplicationIndex(
    gmail,
    account,
    req.query.sentLimit || 50
  );
  pruneUnlinkedJobReplies(account, sentIndex);
  const autoReply = req.query.autoReply === "true";

  const listResponse = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["INBOX"],
    maxResults: Math.min(Number(req.query.limit || 50), 75),
    q:
      req.query.q ||
      '("selected" OR "shortlisted" OR "interview" OR "schedule" OR "congratulations" OR "next round" OR "next steps" OR "hiring" OR "application update" OR "offer")',
  });

  const messagesToProcess = listResponse.data.messages || [];
  
  // Parallelize email fetching
  const emails = await Promise.all(
    messagesToProcess.map(async (item) => {
      try {
        return await getFullMessage(gmail, item.id);
      } catch (error) {
        console.warn(`Failed to fetch email ${item.id}:`, error.message);
        return null;
      }
    })
  );

  // Filter emails and prepare for processing
  const emailsToClassify = emails.filter((email) => {
    if (!email) return false;
    const senderEmail = extractEmailAddress(email.from);
    return (
      sentIndex.threadIds.has(email.threadId) ||
      sentIndex.recipientEmails.has(senderEmail)
    );
  });

  // Parallelize classifications
  const classifications = await Promise.all(
    emailsToClassify.map(async (email) => {
      // Try to use existing classification
      const existing = account.jobReplies[email.id];
      if (existing && existing.analyzedAt) {
        return { email, classification: null, existing }; // null means use existing
      }

      try {
        const classification = await classifyJobReplyEmail(email);
        return { email, classification, existing };
      } catch (error) {
        console.warn(`Classification failed for ${email.id}:`, error.message);
        const inferred = inferJobReplyStatus(email);
        return {
          email,
          classification: {
            isJobRelatedReply: inferred.status !== "other",
            status: inferred.status,
            company: "",
            role: "",
            interviewDate: "",
            reason: inferred.reason,
            confidence: inferred.status === "other" ? 0 : 0.75,
          },
          existing,
        };
      }
    })
  );

  // Process results
  const jobRepliesToGenerate = [];

  for (const { email, classification, existing } of classifications) {
    const senderEmail = extractEmailAddress(email.from);
    const linkedApplication = sentIndex.applicationsByThread[email.threadId];

    // Use existing classification if available
    let finalClassification = classification;
    if (!finalClassification) {
      if (existing) {
        // Reuse existing
        if (
          autoReply &&
          !existing.replySentAt &&
          ["selected", "interview_requested", "shortlisted", "replied"].includes(existing.status)
        ) {
          jobRepliesToGenerate.push({ jobReply: existing, isExisting: true });
        }
        continue;
      } else {
        // Fallback
        const inferred = inferJobReplyStatus(email);
        finalClassification = {
          isJobRelatedReply: inferred.status !== "other",
          status: inferred.status,
          company: linkedApplication?.company || "",
          role: linkedApplication?.role || "",
          interviewDate: "",
          reason: inferred.reason,
          confidence: inferred.status === "other" ? 0 : 0.75,
        };
      }
    }

    // Apply inference as fallback
    const inferred = inferJobReplyStatus(email);
    if (
      inferred.status !== "other" &&
      (finalClassification.status === "other" || finalClassification.confidence < 0.55)
    ) {
      finalClassification = {
        ...finalClassification,
        isJobRelatedReply: true,
        status: inferred.status,
        reason: inferred.reason,
        confidence: Math.max(finalClassification.confidence || 0, 0.75),
      };
    }

    if (
      !finalClassification.isJobRelatedReply ||
      finalClassification.confidence < 0.55 ||
      finalClassification.status === "other"
    ) {
      continue;
    }

    const jobReply = {
      id: email.id,
      threadId: email.threadId,
      linkedApplicationId: linkedApplication?.id || "",
      subject: email.subject,
      from: email.from,
      replyTo: email.replyTo,
      messageId: email.messageId,
      references: email.references,
      date: email.date,
      sortTime: email.sortTime,
      snippet: email.snippet,
      status: finalClassification.status,
      company: finalClassification.company || linkedApplication?.company || "",
      role: finalClassification.role || linkedApplication?.role || "",
      interviewDate: finalClassification.interviewDate || "",
      reason: finalClassification.reason || "",
      confidence: finalClassification.confidence || 0,
      replySentAt: existing?.replySentAt || null,
      analyzedAt: new Date().toISOString(),
    };

    account.jobReplies[email.id] = jobReply;

    if (
      autoReply &&
      !jobReply.replySentAt &&
      ["selected", "interview_requested", "shortlisted", "replied"].includes(jobReply.status)
    ) {
      jobRepliesToGenerate.push({ jobReply, isExisting: false });
    }

    if (linkedApplication) {
      linkedApplication.status = jobReply.status;
      linkedApplication.reason = jobReply.reason;
      linkedApplication.stopFollowUps = [
        "rejected",
        "selected",
        "interview_requested",
        "shortlisted",
      ].includes(jobReply.status);
      linkedApplication.lastAnalyzedAt = new Date().toISOString();
    }
  }

  // Parallelize reply generation and sending
  if (jobRepliesToGenerate.length > 0) {
    const generatePromises = jobRepliesToGenerate.map(async ({ jobReply }) => {
      try {
        return await generateJobReplyEmail(jobReply);
      } catch (error) {
        console.warn(`Generation failed for ${jobReply.id}:`, error.message);
        return null;
      }
    });

    const generated = await Promise.all(generatePromises);
    const sendPromises = jobRepliesToGenerate
      .map((item, i) => ({ item, generated: generated[i] }))
      .filter(({ generated }) => generated)
      .map(async ({ item: { jobReply }, generated }) => {
        try {
          await gmail.users.messages.send({
            userId: "me",
            requestBody: {
              threadId: jobReply.threadId,
              raw: createRawEmail({
                to: jobReply.replyTo || jobReply.from,
                subject: generated.subject,
                body: generated.bodyHtml,
                inReplyTo: jobReply.messageId,
                references: [jobReply.references, jobReply.messageId]
                  .filter(Boolean)
                  .join(" "),
              }),
            },
          });
          jobReply.replySentAt = new Date().toISOString();
          jobReply.autoReplied = true;
        } catch (error) {
          console.warn(`Send failed for ${jobReply.id}:`, error.message);
        }
      });

    await Promise.all(sendPromises);
  }

  writeJobStore(store);
  return account;
}

async function sendInboxAutoReplies(gmail, account, accountEmail, options = {}) {
  const diagnostics = [];
  const query = options.q || "newer_than:30d";
  const limit = Math.min(Number(options.limit || 50), 75);

  logInboxAutoReply("starting scan", {
    accountEmail,
    query,
    limit,
    alreadyTracked: Object.keys(account.inboxAutoReplies || {}).length,
  }, diagnostics);

  const listResponse = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["INBOX"],
    maxResults: limit,
    q: query,
  });

  const listedMessages = listResponse.data.messages || [];
  logInboxAutoReply("gmail list result", {
    accountEmail,
    resultSizeEstimate: listResponse.data.resultSizeEstimate || 0,
    listedCount: listedMessages.length,
    messageIds: listedMessages.map((item) => item.id),
  }, diagnostics);

  const messages = await Promise.all(
    listedMessages.map(async (item) => {
      try {
        const email = await getFullMessage(gmail, item.id);
        logInboxAutoReply("fetched message", {
          id: email.id,
          threadId: email.threadId,
          from: email.from,
          to: email.to,
          subject: email.subject,
          labels: email.labels,
          unread: email.unread,
          date: email.date,
        }, diagnostics);
        return email;
      } catch (error) {
        const details = { id: item.id, error: error.message };
        diagnostics.push({
          at: new Date().toISOString(),
          message: "failed to fetch email",
          details,
        });
        console.warn("[InboxAutoReply] failed to fetch email", details);
        return null;
      }
    })
  );

  const newMessages = trackIncomingMailBatch(
    messages.filter(Boolean),
    "auto-reply-scan",
    `incoming:${accountEmail}`
  );

  for (const email of newMessages) {
    if (!email) {
      logInboxAutoReply("skip null email after fetch failure", undefined, diagnostics);
      continue;
    }

    if (account.inboxAutoReplies[email.id]?.replySentAt) {
      logInboxAutoReply("skip already replied", {
        id: email.id,
        replySentAt: account.inboxAutoReplies[email.id].replySentAt,
      }, diagnostics);
      continue;
    }

    const senderEmail = extractEmailAddress(email.from);
    if (shouldSkipInboxAutoReply(email, accountEmail)) {
      logInboxAutoReply("skip sender", {
        id: email.id,
        from: email.from,
        senderEmail,
        accountEmail,
        reason:
          senderEmail === accountEmail.toLowerCase()
            ? "sender is the connected account"
            : "sender is empty or no-reply/system address",
      }, diagnostics);
      continue;
    }

    logInboxAutoReply("generating nvidia reply for new mail only", {
      id: email.id,
      from: email.from,
      subject: email.subject,
    }, diagnostics);
    const generated = await generateInboxAutoReplyEmail(email);
    logInboxAutoReply("sending reply", {
      id: email.id,
      threadId: email.threadId,
      to: email.replyTo || email.from,
      subject: generated.subject,
      bodyLength: String(generated.bodyHtml || "").length,
      bodyPreview: stripHtml(generated.bodyHtml || "").slice(0, 160),
      generatedBy: "nvidia",
      inReplyTo: email.messageId,
      references: [email.references, email.messageId].filter(Boolean).join(" "),
    }, diagnostics);

    const replyRecord = {
      id: email.id,
      threadId: email.threadId,
      subject: email.subject,
      from: email.from,
      replyTo: email.replyTo,
      messageId: email.messageId,
      references: email.references,
      date: email.date,
      sortTime: email.sortTime,
      snippet: email.snippet,
      status: "replied",
      reason: "Auto reply sent.",
      confidence: 1,
      analyzedAt: new Date().toISOString(),
      autoReplied: true,
      replySentAt: null,
    };

    try {
      await gmail.users.messages.send({
        userId: "me",
        requestBody: {
          threadId: email.threadId,
          raw: createRawEmail({
            to: email.replyTo || email.from,
            subject: generated.subject,
            body: generated.bodyHtml,
            inReplyTo: email.messageId,
            references: [email.references, email.messageId].filter(Boolean).join(" "),
          }),
        },
      });
      replyRecord.replySentAt = new Date().toISOString();
      account.inboxAutoReplies[email.id] = replyRecord;
      account.jobReplies[email.id] = replyRecord;
      logInboxAutoReply("reply sent", {
        id: email.id,
        to: email.replyTo || email.from,
        replySentAt: replyRecord.replySentAt,
      }, diagnostics);
    } catch (error) {
      const details = {
        id: email.id,
        to: email.replyTo || email.from,
        message: error.message,
        code: error.code,
        status: error.status,
        response: error.response?.data,
      };
      diagnostics.push({
        at: new Date().toISOString(),
        message: "auto reply failed",
        details,
      });
      console.warn("[InboxAutoReply] auto reply failed", details);
      replyRecord.reason = `Auto reply failed: ${error.message}`;
      account.inboxAutoReplies[email.id] = replyRecord;
      account.jobReplies[email.id] = replyRecord;
    }
  }

  logInboxAutoReply("scan complete", {
    accountEmail,
    tracked: Object.keys(account.inboxAutoReplies || {}).length,
    sent: Object.values(account.inboxAutoReplies || {}).filter(
      (reply) => reply.replySentAt
    ).length,
  }, diagnostics);

  return { account, diagnostics };
}

async function autoReplyInboxEmails(req) {
  const gmail = getAuthedGmail(req);
  const profile = await gmail.users.getProfile({ userId: "me" });
  const accountEmail = profile.data.emailAddress;
  logInboxAutoReply("manual route connected gmail profile", {
    accountEmail,
    query: req.query.q || "newer_than:30d",
    limit: req.query.limit || 50,
  });
  const store = readJobStore();
  const account = getAccount(store, accountEmail);
  account.encryptedTokens = encryptTokens(req.session.googleTokens);

  const result = await sendInboxAutoReplies(gmail, account, accountEmail, {
    limit: req.query.limit,
    q: req.query.q,
  });

  writeJobStore(store);
  return result;
}

function serializeJobReplies(account) {
  return Object.values(account.jobReplies || {}).sort(
    (a, b) =>
      (b.sortTime || Date.parse(b.date) || 0) -
      (a.sortTime || Date.parse(a.date) || 0)
  );
}

function pruneUnlinkedJobReplies(account, sentIndex) {
  for (const [id, reply] of Object.entries(account.jobReplies || {})) {
    const senderEmail = extractEmailAddress(reply.from);
    const isLinked =
      sentIndex.threadIds.has(reply.threadId) ||
      sentIndex.recipientEmails.has(senderEmail);
    if (!isLinked) {
      delete account.jobReplies[id];
    }
  }
}

async function analyzeImportantInbox(req) {
  const gmail = getAuthedGmail(req);
  const profile = await gmail.users.getProfile({ userId: "me" });
  const store = readJobStore();
  const account = getAccount(store, profile.data.emailAddress);
  account.encryptedTokens = encryptTokens(req.session.googleTokens);

  const listResponse = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["INBOX"],
    maxResults: Math.min(Number(req.query.limit || 50), 75),
    q:
      req.query.q ||
      '("offer letter" OR "selected" OR "congratulations" OR "interview" OR "shortlisted" OR "achievement" OR "award" OR "urgent" OR "important" OR "deadline" OR "job" OR "application" OR "next steps")',
  });

  const messagesToProcess = listResponse.data.messages || [];
  const newEmails = messagesToProcess.filter((item) => !account.importantInbox[item.id]);
  
  if (newEmails.length === 0) {
    writeJobStore(store);
    return account;
  }

  // Parallelize email fetching
  const emails = await Promise.all(
    newEmails.map(async (item) => {
      try {
        return await getFullMessage(gmail, item.id);
      } catch (error) {
        console.warn(`Failed to fetch email ${item.id}:`, error.message);
        return null;
      }
    })
  );

  // Parallelize classifications
  const classifications = await Promise.all(
    emails.map(async (email) => {
      if (!email) return { email: null, classification: null };
      try {
        const classification = await classifyImportantInboxEmail(email);
        return { email, classification };
      } catch (error) {
        console.warn(`Classification failed for ${email.id}:`, error.message);
        return {
          email,
          classification: {
            isImportant: false,
            category: "other",
            title: "",
            reason: "",
            confidence: 0,
          },
        };
      }
    })
  );

  // Process results
  for (const { email, classification } of classifications) {
    if (!email || !classification || !classification.isImportant || classification.confidence < 0.55) {
      continue;
    }

    account.importantInbox[email.id] = {
      id: email.id,
      threadId: email.threadId,
      subject: email.subject,
      from: email.from,
      to: email.to,
      snippet: email.snippet,
      date: email.date,
      internalDate: email.internalDate,
      sortTime: email.sortTime,
      unread: email.unread,
      category: classification.category || "other_important",
      title: classification.title || email.subject,
      reason: classification.reason || "",
      confidence: classification.confidence || 0,
      analyzedAt: new Date().toISOString(),
    };
  }

  writeJobStore(store);
  return account;
}

function serializeImportantInbox(account) {
  return Object.values(account.importantInbox || {}).sort(
    (a, b) =>
      (b.sortTime || Date.parse(b.date) || 0) -
      (a.sortTime || Date.parse(a.date) || 0)
  );
}

async function getFullMessage(gmail, id) {
  const response = await gmail.users.messages.get({
    userId: "me",
    id,
    format: "full",
  });
  return normalizeFullMessage(response.data);
}

async function getThreadMessages(gmail, threadId) {
  const response = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });
  return (response.data.messages || []).map(normalizeFullMessage);
}

async function analyzeSentJobApplications(req) {
  const gmail = getAuthedGmail(req);
  const profile = await gmail.users.getProfile({ userId: "me" });
  const applicantEmail = profile.data.emailAddress;
  const listResponse = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["SENT"],
    maxResults: Math.min(Number(req.query.limit || 25), 50),
    q:
      req.query.q ||
      '("applied" OR "application" OR "resume" OR "cv" OR "job" OR "position" OR "interview")',
  });

  const store = readJobStore();
  const account = getAccount(store, applicantEmail);
  account.encryptedTokens = encryptTokens(req.session.googleTokens);

  const messagesToProcess = listResponse.data.messages || [];

  // Parallelize email fetching
  const sentMessages = await Promise.all(
    messagesToProcess.map(async (item) => {
      try {
        return await getFullMessage(gmail, item.id);
      } catch (error) {
        console.warn(`Failed to fetch email ${item.id}:`, error.message);
        return null;
      }
    })
  );

  const validMessages = sentMessages.filter((msg) => msg !== null);

  // Parallelize classifications
  const classifications = await Promise.all(
    validMessages.map(async (sentMessage) => {
      const existing = account.applications[sentMessage.id];
      if (existing) {
        return { sentMessage, classification: existing };
      }

      try {
        const classification = await classifySentJobEmail(sentMessage);
        return { sentMessage, classification };
      } catch (error) {
        console.warn(`Classification failed for ${sentMessage.id}:`, error.message);
        return {
          sentMessage,
          classification: {
            isJobApplication: looksLikeJobApplication(sentMessage),
            company: "",
            role: "",
            confidence: looksLikeJobApplication(sentMessage) ? 0.7 : 0,
          },
        };
      }
    })
  );

  // Filter and prepare for thread analysis
  const toAnalyze = classifications.filter(({ classification }) => {
    return classification.isJobApplication && classification.confidence >= 0.55;
  });

  // Parallelize thread fetching and analysis
  const outcomes = await Promise.all(
    toAnalyze.map(async ({ sentMessage, classification }) => {
      try {
        const threadMessages = await getThreadMessages(gmail, sentMessage.threadId);
        const outcome = await analyzeThreadOutcome(threadMessages, applicantEmail);
        return { sentMessage, classification, outcome };
      } catch (error) {
        console.warn(`Thread analysis failed for ${sentMessage.id}:`, error.message);
        return {
          sentMessage,
          classification,
          outcome: { status: "no_response", reason: "Analysis failed." },
        };
      }
    })
  );

  // Process results
  for (const { sentMessage, classification, outcome } of outcomes) {
    const now = new Date().toISOString();
    const previous = account.applications[sentMessage.id] || {};
    const stopFollowUps = ["rejected", "selected", "interview_requested"].includes(
      outcome.status
    );

    account.applications[sentMessage.id] = {
      id: sentMessage.id,
      threadId: sentMessage.threadId,
      subject: sentMessage.subject,
      to: sentMessage.to,
      recipientEmail: extractEmailAddress(sentMessage.to),
      date: sentMessage.date,
      company: classification.company || previous.company || "",
      role: classification.role || previous.role || "",
      confidence: classification.confidence,
      status: outcome.status,
      reason: outcome.reason,
      stopFollowUps,
      lastAnalyzedAt: now,
      lastFollowUpAt: previous.lastFollowUpAt || null,
      followUpCount: previous.followUpCount || 0,
    };
  }

  writeJobStore(store);
  return account;
}

function getDueApplications(account) {
  const now = Date.now();
  return Object.values(account.applications).filter((application) => {
    if (application.stopFollowUps) return false;
    if (application.status !== "no_response") return false;
    const last = application.lastFollowUpAt
      ? new Date(application.lastFollowUpAt).getTime()
      : new Date(application.date || 0).getTime();
    return Number.isFinite(last) && now - last >= FIFTEEN_HOURS_MS;
  });
}

async function sendFollowUp(gmail, application) {
  const generated = await generateFollowUpEmail(application);
  const sent = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: createRawEmail({
        to: application.to,
        subject: generated.subject,
        body: generated.bodyHtml,
      }),
    },
  });
  return sent.data;
}

async function runDueFollowUps() {
  const store = readJobStore();
  let changed = false;

  for (const [emailAddress, account] of Object.entries(store.accounts)) {
    if (!account.encryptedTokens) continue;
    const tokens = decryptTokens(account.encryptedTokens);
    const gmail = getGmailFromTokens(tokens);

    try {
      const before = Object.values(account.inboxAutoReplies || {}).filter(
        (reply) => reply.replySentAt
      ).length;
      await sendInboxAutoReplies(gmail, account, emailAddress);
      const after = Object.values(account.inboxAutoReplies || {}).filter(
        (reply) => reply.replySentAt
      ).length;
      if (after !== before) changed = true;
    } catch (error) {
      console.warn(`Inbox auto reply failed for ${emailAddress}: ${error.message}`);
    }

    if (!account.automationEnabled) continue;
    for (const application of getDueApplications(account)) {
      try {
        await sendFollowUp(gmail, application);
        application.lastFollowUpAt = new Date().toISOString();
        application.followUpCount = (application.followUpCount || 0) + 1;
        application.reason = "Follow-up sent automatically.";
        changed = true;
        console.log(`Follow-up sent to ${application.recipientEmail} for ${emailAddress}`);
      } catch (error) {
        application.reason = `Follow-up failed: ${error.message}`;
        changed = true;
      }
    }
  }

  if (changed) writeJobStore(store);
}

async function labelCount(gmail, labelId) {
  const response = await gmail.users.labels.get({ userId: "me", id: labelId });
  return {
    total: response.data.messagesTotal || 0,
    unread: response.data.messagesUnread || 0,
  };
}

module.exports = {
  GMAIL_SCOPES,
  INBOX_CATEGORY_LABELS,
  getOAuthClient,
  getAuthedGmail,
  getGmailFromTokens,
  normalizeMessage,
  normalizeFullMessage,
  listMessages,
  createRawEmail,
  readJobStore,
  writeJobStore,
  getAccount,
  encryptTokens,
  decryptTokens,
  extractEmailAddress,
  generateJobReplyEmail,
  analyzeJobReplies,
  autoReplyInboxEmails,
  serializeJobReplies,
  analyzeImportantInbox,
  serializeImportantInbox,
  getFullMessage,
  getThreadMessages,
  analyzeSentJobApplications,
  getDueApplications,
  sendFollowUp,
  runDueFollowUps,
  labelCount,
};
