import { createRequire } from "module";
import crypto from "crypto";
import { NextResponse } from "next/server";

const require = createRequire(import.meta.url);
const core = require("../../../lib/gmailCore.cjs");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_COOKIE = "gmail.session";
const SESSION_MAX_AGE = 1000 * 60 * 60 * 24 * 7;

function getSessionKey() {
  return crypto
    .createHash("sha256")
    .update(process.env.SESSION_SECRET || "change-me-in-env")
    .digest();
}

function encodeBase64Url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64");
}

function encryptSession(session) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getSessionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(session), "utf8"),
    cipher.final(),
  ]);
  return [
    encodeBase64Url(iv),
    encodeBase64Url(cipher.getAuthTag()),
    encodeBase64Url(encrypted),
  ].join(".");
}

function decryptSession(value) {
  if (!value) return {};
  try {
    const [iv, tag, encrypted] = value.split(".");
    if (!iv || !tag || !encrypted) return {};
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      getSessionKey(),
      decodeBase64Url(iv)
    );
    decipher.setAuthTag(decodeBase64Url(tag));
    const decrypted = Buffer.concat([
      decipher.update(decodeBase64Url(encrypted)),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString("utf8"));
  } catch {
    return {};
  }
}

function serializeCookie(name, value, options = {}) {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor((options.maxAge ?? SESSION_MAX_AGE) / 1000)}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

function commitSession(response, session, clearSession = false) {
  if (clearSession) {
    response.headers.append(
      "Set-Cookie",
      serializeCookie(SESSION_COOKIE, "", { maxAge: 0 })
    );
    return response;
  }

  response.headers.append(
    "Set-Cookie",
    serializeCookie(SESSION_COOKIE, encryptSession(session))
  );
  return response;
}

function json(data, session, init = {}) {
  return commitSession(NextResponse.json(data, init), session);
}

function getQuery(request) {
  return Object.fromEntries(request.nextUrl.searchParams.entries());
}

async function getBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return {};
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function getRequestContext(request, params) {
  return {
    session: decryptSession(request.cookies.get(SESSION_COOKIE)?.value),
    query: getQuery(request),
    body: await getBody(request),
    params: params || {},
  };
}

function redirect(location, session) {
  return commitSession(
    NextResponse.redirect(
      new URL(location, process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000")
    ),
    session
  );
}

async function handleAuth(request, path, req) {
  if (path === "auth/google" && request.method === "GET") {
    const auth = core.getOAuthClient();
    const url = auth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: core.GMAIL_SCOPES,
    });
    return NextResponse.redirect(url);
  }

  if (path === "auth/google/callback" && request.method === "GET") {
    const auth = core.getOAuthClient();
    const code = request.nextUrl.searchParams.get("code");
    if (!code) return json({ error: "Google OAuth code is missing." }, req.session, { status: 400 });

    const { tokens } = await auth.getToken(code);
    req.session.googleTokens = tokens;
    auth.setCredentials(tokens);

    try {
      const gmail = core.getGmailFromTokens(tokens);
      const profile = await gmail.users.getProfile({ userId: "me" });
      req.session.gmailEmail = profile.data.emailAddress;
    } catch (error) {
      console.warn(`Unable to store Gmail profile in session: ${error.message}`);
    }

    return redirect("/dashboard", req.session);
  }

  if (path === "auth/status" && request.method === "GET") {
    if (!req.session.googleTokens) {
      return json({ connected: false, emailAddress: null }, req.session);
    }

    if (req.session.gmailEmail) {
      return json(
        { connected: true, emailAddress: req.session.gmailEmail },
        req.session
      );
    }

    const gmail = core.getAuthedGmail(req);
    const profile = await gmail.users.getProfile({ userId: "me" });
    req.session.gmailEmail = profile.data.emailAddress;
    return json({ connected: true, emailAddress: profile.data.emailAddress }, req.session);
  }

  if (path === "auth/logout" && request.method === "POST") {
    return commitSession(NextResponse.json({ ok: true }), req.session, true);
  }

  if (path === "auth/disconnect" && request.method === "POST") {
    const tokens = req.session.googleTokens;
    if (tokens?.access_token) {
      try {
        const auth = core.getOAuthClient();
        await auth.revokeToken(tokens.access_token);
      } catch (error) {
        console.warn(`Google token revoke failed: ${error.message}`);
      }
    }
    return commitSession(NextResponse.json({ ok: true }), req.session, true);
  }

  return null;
}

async function handleGmail(request, parts, req) {
  if (parts[0] !== "gmail") return null;

  const path = parts.join("/");
  const gmail = core.getAuthedGmail(req);

  if (path === "gmail/profile" && request.method === "GET") {
    const profile = await gmail.users.getProfile({ userId: "me" });
    return json(profile.data, req.session);
  }

  const mailboxRoutes = {
    "gmail/inbox": ["INBOX", core.INBOX_CATEGORY_LABELS[req.query.category] || core.INBOX_CATEGORY_LABELS.primary],
    "gmail/sent": ["SENT"],
    "gmail/unread": ["UNREAD"],
    "gmail/drafts": ["DRAFT"],
    "gmail/spam": ["SPAM"],
    "gmail/trash": ["TRASH"],
  };

  if (request.method === "GET" && mailboxRoutes[path]) {
    return json(await core.listMessages(req, mailboxRoutes[path]), req.session);
  }

  if (path === "gmail/stats" && request.method === "GET") {
    const [inbox, sent, drafts, unread, spam, trash] = await Promise.all([
      core.labelCount(gmail, "INBOX"),
      core.labelCount(gmail, "SENT"),
      core.labelCount(gmail, "DRAFT"),
      core.labelCount(gmail, "UNREAD"),
      core.labelCount(gmail, "SPAM"),
      core.labelCount(gmail, "TRASH"),
    ]);

    return json(
      {
        inbox: inbox.total,
        sent: sent.total,
        drafts: drafts.total,
        unread: unread.total,
        spam: spam.total,
        trash: trash.total,
      },
      req.session
    );
  }

  if (parts[0] === "gmail" && parts[1] === "message" && parts[2]) {
    const id = parts[2];

    if (parts.length === 3 && request.method === "GET") {
      const message = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "full",
      });
      return json(core.normalizeFullMessage(message.data), req.session);
    }

    if (parts[3] === "attachment" && parts[4] && request.method === "GET") {
      const attachment = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: id,
        id: parts[4],
      });
      const buffer = Buffer.from(
        (attachment.data.data || "").replace(/-/g, "+").replace(/_/g, "/"),
        "base64"
      );
      const filename = req.query.filename || "attachment";
      const mimeType = req.query.mimeType || "application/octet-stream";
      const response = new Response(buffer, {
        headers: {
          "Content-Type": mimeType,
          "Content-Disposition": `attachment; filename="${String(filename).replace(/"/g, "")}"`,
        },
      });
      return commitSession(response, req.session);
    }
  }

  if (path === "gmail/send" && request.method === "POST") {
    if (!req.body.to) {
      return json({ error: "Recipient is required." }, req.session, { status: 400 });
    }
    const sent = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: core.createRawEmail(req.body) },
    });
    return json(sent.data, req.session, { status: 201 });
  }

  if (parts[0] === "gmail" && parts[1] === "read" && parts[2] && request.method === "PATCH") {
    const updated = await gmail.users.messages.modify({
      userId: "me",
      id: parts[2],
      requestBody: { removeLabelIds: ["UNREAD"] },
    });
    return json(core.normalizeMessage(updated.data), req.session);
  }

  if (parts[0] === "gmail" && parts[1] === "delete" && parts[2] && request.method === "DELETE") {
    await gmail.users.messages.trash({ userId: "me", id: parts[2] });
    return commitSession(new Response(null, { status: 204 }), req.session);
  }

  return null;
}

async function handleJobs(request, parts, req) {
  const path = parts.join("/");

  if (path === "jobs/analyze-sent" && request.method === "POST") {
    const account = await core.analyzeSentJobApplications(req);
    return json(
      {
        automationEnabled: account.automationEnabled,
        applications: Object.values(account.applications).sort(
          (a, b) => new Date(b.date || 0) - new Date(a.date || 0)
        ),
        due: core.getDueApplications(account),
      },
      req.session
    );
  }

  if (path === "jobs/followups" && request.method === "GET") {
    const gmail = core.getAuthedGmail(req);
    const profile = await gmail.users.getProfile({ userId: "me" });
    const store = core.readJobStore();
    const account = core.getAccount(store, profile.data.emailAddress);
    account.encryptedTokens = core.encryptTokens(req.session.googleTokens);
    core.writeJobStore(store);
    return json(
      {
        automationEnabled: account.automationEnabled,
        applications: Object.values(account.applications).sort(
          (a, b) => new Date(b.date || 0) - new Date(a.date || 0)
        ),
        due: core.getDueApplications(account),
      },
      req.session
    );
  }

  if (path === "jobs/followups/settings" && request.method === "PATCH") {
    const gmail = core.getAuthedGmail(req);
    const profile = await gmail.users.getProfile({ userId: "me" });
    const store = core.readJobStore();
    const account = core.getAccount(store, profile.data.emailAddress);
    account.automationEnabled = Boolean(req.body.automationEnabled);
    account.encryptedTokens = core.encryptTokens(req.session.googleTokens);
    core.writeJobStore(store);
    return json({ automationEnabled: account.automationEnabled }, req.session);
  }

  if (
    parts[0] === "jobs" &&
    parts[1] === "followups" &&
    parts[2] &&
    parts[3] === "send" &&
    request.method === "POST"
  ) {
    const gmail = core.getAuthedGmail(req);
    const profile = await gmail.users.getProfile({ userId: "me" });
    const store = core.readJobStore();
    const account = core.getAccount(store, profile.data.emailAddress);
    const application = account.applications[parts[2]];

    if (!application) {
      return json({ error: "Job application not found." }, req.session, { status: 404 });
    }
    if (application.stopFollowUps) {
      return json(
        { error: "Follow-ups are stopped for this email because a final response exists." },
        req.session,
        { status: 400 }
      );
    }

    const sent = await core.sendFollowUp(gmail, application);
    application.lastFollowUpAt = new Date().toISOString();
    application.followUpCount = (application.followUpCount || 0) + 1;
    account.encryptedTokens = core.encryptTokens(req.session.googleTokens);
    core.writeJobStore(store);
    return json({ sent, application }, req.session, { status: 201 });
  }

  if (path === "jobs/replies" && request.method === "GET") {
    const gmail = core.getAuthedGmail(req);
    const profile = await gmail.users.getProfile({ userId: "me" });
    const store = core.readJobStore();
    const account = core.getAccount(store, profile.data.emailAddress);
    account.encryptedTokens = core.encryptTokens(req.session.googleTokens);
    core.writeJobStore(store);
    return json({ replies: core.serializeJobReplies(account) }, req.session);
  }

  if (path === "jobs/replies/analyze" && request.method === "POST") {
    if (req.query.autoReply === "true") {
      const { account, diagnostics } = await core.autoReplyInboxEmails(req);
      return json(
        { replies: core.serializeJobReplies(account), diagnostics },
        req.session
      );
    }

    const account = await core.analyzeJobReplies(req);
    return json({ replies: core.serializeJobReplies(account), diagnostics: [] }, req.session);
  }

  if (
    parts[0] === "jobs" &&
    parts[1] === "replies" &&
    parts[2] &&
    parts[3] === "generate" &&
    request.method === "POST"
  ) {
    const gmail = core.getAuthedGmail(req);
    const profile = await gmail.users.getProfile({ userId: "me" });
    const store = core.readJobStore();
    const account = core.getAccount(store, profile.data.emailAddress);
    const jobReply = account.jobReplies[parts[2]];
    if (!jobReply) {
      return json({ error: "Job reply not found." }, req.session, { status: 404 });
    }
    return json(await core.generateJobReplyEmail(jobReply), req.session);
  }

  if (
    parts[0] === "jobs" &&
    parts[1] === "replies" &&
    parts[2] &&
    parts[3] === "send" &&
    request.method === "POST"
  ) {
    const gmail = core.getAuthedGmail(req);
    const profile = await gmail.users.getProfile({ userId: "me" });
    const store = core.readJobStore();
    const account = core.getAccount(store, profile.data.emailAddress);
    const jobReply = account.jobReplies[parts[2]];
    if (!jobReply) {
      return json({ error: "Job reply not found." }, req.session, { status: 404 });
    }

    const generated =
      req.body.subject && req.body.bodyHtml
        ? { subject: req.body.subject, bodyHtml: req.body.bodyHtml }
        : await core.generateJobReplyEmail(jobReply);
    const sent = await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        threadId: jobReply.threadId,
        raw: core.createRawEmail({
          to: jobReply.replyTo || jobReply.from,
          subject: generated.subject,
          body: generated.bodyHtml,
          inReplyTo: jobReply.messageId,
          references: [jobReply.references, jobReply.messageId].filter(Boolean).join(" "),
        }),
      },
    });

    jobReply.replySentAt = new Date().toISOString();
    account.encryptedTokens = core.encryptTokens(req.session.googleTokens);
    core.writeJobStore(store);
    return json({ sent: sent.data, reply: jobReply }, req.session, { status: 201 });
  }

  return null;
}

async function handleImportantInbox(request, path, req) {
  if (path === "inbox/important" && request.method === "GET") {
    const gmail = core.getAuthedGmail(req);
    const profile = await gmail.users.getProfile({ userId: "me" });
    const store = core.readJobStore();
    const account = core.getAccount(store, profile.data.emailAddress);
    account.encryptedTokens = core.encryptTokens(req.session.googleTokens);
    core.writeJobStore(store);
    return json({ emails: core.serializeImportantInbox(account) }, req.session);
  }

  if (path === "inbox/important/analyze" && request.method === "POST") {
    const account = await core.analyzeImportantInbox(req);
    return json({ emails: core.serializeImportantInbox(account) }, req.session);
  }

  return null;
}

async function handleCron(request, path, req) {
  if (path !== "cron/followups" || request.method !== "GET") return null;

  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const providedSecret = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (providedSecret !== expectedSecret) {
      return json({ error: "Unauthorized cron request." }, req.session, { status: 401 });
    }
  }

  await core.runDueFollowUps();
  return json({ ok: true }, req.session);
}

async function dispatch(request, context) {
  const { path: rawPath = [] } = await context.params;
  const parts = rawPath.map((part) => decodeURIComponent(part));
  const path = parts.join("/");
  const req = await getRequestContext(request);

  const response =
    (await handleAuth(request, path, req)) ||
    (await handleGmail(request, parts, req)) ||
    (await handleJobs(request, parts, req)) ||
    (await handleImportantInbox(request, path, req)) ||
    (await handleCron(request, path, req));

  if (response) return response;
  return json({ error: "API route not found." }, req.session, { status: 404 });
}

async function route(request, context) {
  try {
    return await dispatch(request, context);
  } catch (error) {
    const status = error.statusCode || error.code || 500;
    const body = {
      error: status === 401 ? error.message : "Gmail request failed.",
      details: process.env.NODE_ENV !== "production" ? error.message : undefined,
    };
    const req = await getRequestContext(request).catch(() => ({ session: {} }));
    return json(body, req.session, { status: status === 401 ? 401 : 500 });
  }
}

export const GET = route;
export const POST = route;
export const PATCH = route;
export const DELETE = route;
