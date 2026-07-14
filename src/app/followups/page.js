"use client";

import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { api, getErrorMessage } from "@/lib/api";

function statusTone(status) {
  if (status === "no_response") return "bg-amber-50 text-amber-700";
  if (["rejected", "selected", "interview_requested"].includes(status)) {
    return "bg-emerald-50 text-emerald-700";
  }
  return "bg-zinc-100 text-zinc-700";
}

export default function FollowUpsPage() {
  const [applications, setApplications] = useState([]);
  const [due, setDue] = useState([]);
  const [automationEnabled, setAutomationEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await api.get("/api/jobs/followups");
      setApplications(response.data.applications || []);
      setDue(response.data.due || []);
      setAutomationEnabled(Boolean(response.data.automationEnabled));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  async function analyzeSent() {
    setAnalyzing(true);
    setError("");
    try {
      const response = await api.post("/api/jobs/analyze-sent?limit=25");
      setApplications(response.data.applications || []);
      setDue(response.data.due || []);
      setAutomationEnabled(Boolean(response.data.automationEnabled));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setAnalyzing(false);
    }
  }

  async function toggleAutomation() {
    const next = !automationEnabled;
    setAutomationEnabled(next);
    try {
      await api.patch("/api/jobs/followups/settings", {
        automationEnabled: next,
      });
    } catch (err) {
      setAutomationEnabled(!next);
      setError(getErrorMessage(err));
    }
  }

  async function sendNow(id) {
    setError("");
    try {
      await api.post(`/api/jobs/followups/${id}/send`);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  useEffect(() => {
    // This page syncs stored follow-up state from the Express API on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return (
    <AppShell>
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Job Follow-ups</h1>
          <p className="mt-1 text-sm text-zinc-500">
            NVIDIA AI analyzes your sent emails to detect job applications and recruiter replies.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={analyzeSent}
            disabled={analyzing}
            className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {analyzing ? "Analyzing..." : "Analyze Sent"}
          </button>
          <button
            type="button"
            onClick={toggleAutomation}
            className={`rounded-md px-4 py-2 text-sm font-medium ${
              automationEnabled
                ? "bg-emerald-600 text-white hover:bg-emerald-700"
                : "border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
            }`}
          >
            {automationEnabled ? "Automation On" : "Automation Off"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <div className="rounded-md border border-zinc-200 bg-white p-4">
          <p className="text-sm text-zinc-500">Job Applications</p>
          <p className="mt-2 text-2xl font-semibold">{applications.length}</p>
        </div>
        <div className="rounded-md border border-zinc-200 bg-white p-4">
          <p className="text-sm text-zinc-500">Due Follow-ups</p>
          <p className="mt-2 text-2xl font-semibold">{due.length}</p>
        </div>
        <div className="rounded-md border border-zinc-200 bg-white p-4">
          <p className="text-sm text-zinc-500">Daily Scheduler</p>
          <p className="mt-2 text-2xl font-semibold">
            {automationEnabled ? "Active" : "Paused"}
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-md border border-zinc-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-4 py-3">Application</th>
                <th className="px-4 py-3">Recipient</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Follow-ups</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {loading && (
                <tr>
                  <td className="px-4 py-6 text-zinc-500" colSpan="6">
                    Loading...
                  </td>
                </tr>
              )}
              {!loading && applications.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-zinc-500" colSpan="6">
                    No job applications found yet. Click Analyze Sent.
                  </td>
                </tr>
              )}
              {applications.map((application) => {
                const canFollowUp =
                  application.status === "no_response" && !application.stopFollowUps;
                return (
                  <tr key={application.id}>
                    <td className="max-w-xs px-4 py-3">
                      <p className="font-medium text-zinc-950">
                        {application.role || application.subject}
                      </p>
                      <p className="mt-1 truncate text-xs text-zinc-500">
                        {application.company || application.subject}
                      </p>
                    </td>
                    <td className="max-w-[220px] truncate px-4 py-3 text-zinc-700">
                      {application.to}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-md px-2 py-1 text-xs font-medium ${statusTone(
                          application.status
                        )}`}
                      >
                        {application.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-zinc-700">
                      {application.followUpCount || 0}
                    </td>
                    <td className="max-w-xs truncate px-4 py-3 text-zinc-500">
                      {application.reason}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => sendNow(application.id)}
                        disabled={!canFollowUp}
                        className="rounded-md border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Send Now
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
