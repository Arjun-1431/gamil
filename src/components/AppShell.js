"use client";

import { useEffect } from "react";
import { api } from "@/lib/api";
import Sidebar from "./Sidebar";

export default function AppShell({ children }) {
  useEffect(() => {
    let stopped = false;

    async function pollIncomingMail() {
      if (stopped) return;
      try {
        await api.post(
          "/api/jobs/replies/analyze?limit=10&autoReply=true&q=newer_than:10m"
        );
      } catch (error) {
        console.warn("[IncomingMail] background poll failed", {
          message: error?.message,
          status: error?.response?.status,
          details: error?.response?.data,
        });
      }
    }

    pollIncomingMail();
    const intervalId = window.setInterval(pollIncomingMail, 10000);

    return () => {
      stopped = true;
      window.clearInterval(intervalId);
    };
  }, []);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-950 md:flex">
      <Sidebar />
      <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
    </div>
  );
}
