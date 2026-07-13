"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import { api, getErrorMessage } from "@/lib/api";

const statCards = [
  ["inbox", "Total Inbox"],
  ["sent", "Total Sent"],
  ["drafts", "Total Drafts"],
  ["unread", "Total Unread"],
  ["spam", "Total Spam"],
  ["trash", "Total Trash"],
];

export default function DashboardPage() {
  const [stats, setStats] = useState(null);
  const [profile, setProfile] = useState(null);
  const [connected, setConnected] = useState(false);
  const [importantEmails, setImportantEmails] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [analyzingImportant, setAnalyzingImportant] = useState(false);

  const importantSummary = useMemo(() => {
    return importantEmails.reduce((summary, email) => {
      summary[email.category] = (summary[email.category] || 0) + 1;
      return summary;
    }, {});
  }, [importantEmails]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [profileResponse, statsResponse, importantResponse] =
        await Promise.all([
          api.get("/api/gmail/profile"),
          api.get("/api/gmail/stats"),
          api.get("/api/inbox/important"),
        ]);
      setProfile(profileResponse.data);
      setConnected(true);
      setStats(statsResponse.data);
      setImportantEmails(
        (importantResponse.data.emails || []).sort(
          (a, b) =>
            (b.sortTime || Date.parse(b.date) || 0) -
            (a.sortTime || Date.parse(a.date) || 0)
        )
      );
    } catch (err) {
      setConnected(false);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // This dashboard syncs Gmail stats and stored AI highlights on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function analyzeImportantInbox() {
    setAnalyzingImportant(true);
    setError("");
    try {
      const response = await api.post("/api/inbox/important/analyze?limit=50");
      setImportantEmails(response.data.emails || []);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setAnalyzingImportant(false);
    }
  }

  function connectGmail() {
    window.location.assign("/api/auth/google");
  }

  return (
    <AppShell>
      <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {profile?.emailAddress || "Connect Gmail to load account statistics."}
          </p>
        </div>
        {!connected && (
          <button
            type="button"
            onClick={connectGmail}
            className="w-fit rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
          >
            Connect Gmail
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
          {!connected && (
            <>
              {" "}
              <button
                type="button"
                onClick={connectGmail}
                className="font-medium underline"
              >
                Connect Gmail
              </button>
            </>
          )}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {statCards.map(([key, label]) => (
          <div key={key} className="rounded-md border border-zinc-200 bg-white p-5">
            <p className="text-sm font-medium text-zinc-500">{label}</p>
            <p className="mt-3 text-3xl font-semibold text-zinc-950">
              {loading ? "..." : stats?.[key] ?? 0}
            </p>
          </div>
        ))}
      </div>

      <section className="mt-6">
        <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-semibold">Important Inbox</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Job responses, offer letters, selections, achievements, and urgent emails are highlighted separately.
            </p>
          </div>
          <button
            type="button"
            onClick={analyzeImportantInbox}
            disabled={analyzingImportant}
            className="w-fit rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {analyzingImportant ? "Analyzing..." : "Analyze Important Inbox"}
          </button>
        </div>

        <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {[
            ["job_response", "Job Responses"],
            ["selection", "Selections"],
            ["offer_letter", "Offer Letters"],
            ["interview", "Interviews"],
            ["achievement", "Achievements"],
          ].map(([key, label]) => (
            <div key={key} className="rounded-md border border-zinc-200 bg-white p-4">
              <p className="text-xs font-medium uppercase text-zinc-500">{label}</p>
              <p className="mt-2 text-2xl font-semibold">
                {importantSummary[key] || 0}
              </p>
            </div>
          ))}
        </div>

        <div className="overflow-hidden rounded-md border border-zinc-200 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase text-zinc-500">
                <tr>
                  <th className="px-4 py-3">Mail</th>
                  <th className="px-4 py-3">From</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Why important</th>
                  <th className="px-4 py-3">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {loading && (
                  <tr>
                    <td colSpan="5" className="px-4 py-6 text-zinc-500">
                      Loading important emails...
                    </td>
                  </tr>
                )}
                {!loading && importantEmails.length === 0 && (
                  <tr>
                    <td colSpan="5" className="px-4 py-6 text-zinc-500">
                      No AI highlights yet. Click Analyze Important Inbox.
                    </td>
                  </tr>
                )}
                {importantEmails.slice(0, 15).map((email) => (
                  <tr key={email.id}>
                    <td className="max-w-xs px-4 py-3">
                      <Link
                        href={`/email/${email.id}`}
                        className="block truncate font-medium text-zinc-950 hover:text-red-700"
                      >
                        {email.title || email.subject}
                      </Link>
                      <p className="mt-1 truncate text-xs text-zinc-500">
                        {email.snippet}
                      </p>
                    </td>
                    <td className="max-w-[220px] truncate px-4 py-3 text-zinc-700">
                      {email.from}
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-700">
                        {email.category}
                      </span>
                    </td>
                    <td className="max-w-xs truncate px-4 py-3 text-zinc-500">
                      {email.reason}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-zinc-500">
                      {email.date ? new Date(email.date).toLocaleDateString() : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </AppShell>
  );
}
