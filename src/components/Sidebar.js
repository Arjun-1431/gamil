"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

const items = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/inbox", label: "Inbox" },
  { href: "/sent", label: "Sent" },
  { href: "/followups", label: "Follow-ups" },
  { href: "/job-replies", label: "Job Replies" },
  { href: "/drafts", label: "Drafts" },
  { href: "/spam", label: "Spam" },
  { href: "/trash", label: "Trash" },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [disconnecting, setDisconnecting] = useState(false);
  const [authStatus, setAuthStatus] = useState({
    loading: true,
    connected: false,
    emailAddress: null,
  });

  useEffect(() => {
    async function loadStatus() {
      try {
        const response = await api.get("/api/auth/status");
        setAuthStatus({
          loading: false,
          connected: Boolean(response.data.connected),
          emailAddress: response.data.emailAddress || null,
        });
      } catch {
        setAuthStatus({ loading: false, connected: false, emailAddress: null });
      }
    }

    loadStatus();
  }, []);

  async function disconnectGmail() {
    setDisconnecting(true);
    try {
      await api.post("/api/auth/disconnect");
      window.location.href = "/dashboard";
    } finally {
      setDisconnecting(false);
    }
  }

  function connectGmail() {
    window.location.assign("/api/auth/google");
  }

  return (
    <aside className="w-full border-b border-zinc-200 bg-white md:min-h-screen md:w-64 md:border-b-0 md:border-r">
      <div className="flex items-center justify-between gap-3 px-5 py-4 md:block">
        <Link href="/dashboard" className="text-lg font-semibold text-zinc-950">
          Gmail Console
        </Link>
        {authStatus.connected ? (
          <>
            <div className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              <p className="font-medium">Connected</p>
              <p className="truncate">{authStatus.emailAddress}</p>
            </div>
            <button
              type="button"
              onClick={disconnectGmail}
              disabled={disconnecting}
              className="mt-2 rounded-md border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 md:block md:w-full"
            >
              {disconnecting ? "Disconnecting..." : "Disconnect"}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={connectGmail}
            className="rounded-md bg-zinc-950 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 md:mt-4 md:block md:text-center"
          >
            {authStatus.loading ? "Checking..." : "Connect"}
          </button>
        )}
      </div>
      <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:block md:space-y-1 md:overflow-visible">
        {items.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`block whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium ${
                active
                  ? "bg-red-50 text-red-700"
                  : "text-zinc-700 hover:bg-zinc-100 hover:text-zinc-950"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
