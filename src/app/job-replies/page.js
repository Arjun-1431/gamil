"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { api, getErrorMessage } from "@/lib/api";

function statusTone(status) {
  if (["selected", "interview_requested", "shortlisted"].includes(status)) {
    return "bg-emerald-50 text-emerald-700";
  }
  if (status === "rejected") return "bg-red-50 text-red-700";
  return "bg-zinc-100 text-zinc-700";
}

export default function JobRepliesPage() {
  const [replies, setReplies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [autoReplying, setAutoReplying] = useState(false);
  const [error, setError] = useState("");
  const [diagnostics, setDiagnostics] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await api.get("/api/jobs/replies");
      setReplies(response.data.replies || []);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Sync stored job reply analysis from the Express API on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function replyInboxEmails() {
    setAutoReplying(true);
    setError("");
    try {
      const response = await api.post(
        "/api/jobs/replies/analyze?limit=10&autoReply=true&q=newer_than:10m"
      );
      setReplies(response.data.replies || []);
      setDiagnostics(response.data.diagnostics || []);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setAutoReplying(false);
    }
  }

  return (
    <AppShell>
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Email Replies</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Send a simple reply to new unread emails from the connected Gmail account.
          </p>
        </div>
        <button
          type="button"
          onClick={replyInboxEmails}
          disabled={autoReplying}
          className="w-fit rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {autoReplying ? "Replying..." : "Reply Inbox Emails"}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {diagnostics.length > 0 && (
        <div className="mb-4 rounded-md border border-zinc-200 bg-white p-4">
          <p className="text-sm font-medium text-zinc-950">Reply diagnostics</p>
          <div className="mt-3 space-y-2">
            {diagnostics.map((item, index) => (
              <pre
                key={`${item.at}-${index}`}
                className="overflow-x-auto rounded-md bg-zinc-950 p-3 text-xs text-zinc-50"
              >
                {JSON.stringify(item, null, 2)}
              </pre>
            ))}
          </div>
        </div>
      )}

      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <div className="rounded-md border border-zinc-200 bg-white p-4">
          <p className="text-sm text-zinc-500">Emails Tracked</p>
          <p className="mt-2 text-2xl font-semibold">{replies.length}</p>
        </div>
        <div className="rounded-md border border-zinc-200 bg-white p-4">
          <p className="text-sm text-zinc-500">Replies Sent</p>
          <p className="mt-2 text-2xl font-semibold">
            {replies.filter((reply) => reply.replySentAt).length}
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {loading && (
          <div className="rounded-md border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
            Loading...
          </div>
        )}
        {!loading && replies.length === 0 && (
          <div className="rounded-md border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
            No replies sent yet. Click Reply Inbox Emails to reply to new unread emails.
          </div>
        )}
        {replies.map((reply) => (
            <section
              key={reply.id}
              className="rounded-md border border-zinc-200 bg-white p-4"
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <Link
                    href={`/email/${reply.id}`}
                    className="text-lg font-semibold text-zinc-950 hover:text-red-700"
                  >
                    {reply.subject}
                  </Link>
                  <p className="mt-1 truncate text-sm text-zinc-500">
                    {reply.from}
                  </p>
                  <p className="mt-2 text-sm text-zinc-600">{reply.reason}</p>
                  {reply.interviewDate && (
                    <p className="mt-1 text-sm font-medium text-zinc-950">
                      Interview: {reply.interviewDate}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <span
                    className={`rounded-md px-2 py-1 text-xs font-medium ${statusTone(
                      reply.status
                    )}`}
                  >
                    {reply.status}
                  </span>
                  {reply.replySentAt && (
                    <span className="rounded-md bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">
                      replied
                    </span>
                  )}
                  {reply.autoReplied && (
                    <span className="rounded-md bg-purple-50 px-2 py-1 text-xs font-medium text-purple-700">
                      auto replied
                    </span>
                  )}
                </div>
              </div>
            </section>
        ))}
      </div>
    </AppShell>
  );
}
