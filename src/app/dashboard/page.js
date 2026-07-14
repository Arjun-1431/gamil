"use client";

import { useCallback, useEffect, useState } from "react";
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
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [profileResult, statsResult] = await Promise.allSettled([
        api.get("/api/gmail/profile"),
        api.get("/api/gmail/stats"),
      ]);

      if (profileResult.status === "rejected") {
        throw profileResult.reason;
      }

      setProfile(profileResult.value.data);
      setConnected(true);

      if (statsResult.status === "fulfilled") {
        setStats(statsResult.value.data);
      } else {
        setStats(null);
        setError(getErrorMessage(statsResult.reason));
      }
    } catch (err) {
      setConnected(false);
      setProfile(null);
      setStats(null);
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
    </AppShell>
  );
}
