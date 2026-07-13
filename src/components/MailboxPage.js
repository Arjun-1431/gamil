"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AppShell from "./AppShell";
import EmailTable from "./EmailTable";
import { api, getErrorMessage } from "@/lib/api";

const inboxCategories = [
  { key: "primary", label: "Primary" },
  { key: "promotions", label: "Promotions" },
  { key: "social", label: "Social" },
  { key: "updates", label: "Updates" },
  { key: "forums", label: "Forums" },
];

export default function MailboxPage({ title, endpoint }) {
  const [emails, setEmails] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [nextPageToken, setNextPageToken] = useState(null);
  const [pageTokens, setPageTokens] = useState([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [inboxCategory, setInboxCategory] = useState("primary");
  const [filters, setFilters] = useState({
    subject: "",
    sender: "",
    date: "",
  });

  const isInbox = endpoint === "/api/gmail/inbox";
  const currentToken = pageTokens[pageIndex] || null;
  const params = useMemo(
    () => ({
      limit: 20,
      pageToken: currentToken || undefined,
      category: isInbox ? inboxCategory : undefined,
      subject: filters.subject || undefined,
      sender: filters.sender || undefined,
      date: filters.date || undefined,
    }),
    [currentToken, filters, inboxCategory, isInbox]
  );

  const loadEmails = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await api.get(endpoint, { params });
      const sortedEmails = (response.data.emails || []).sort(
        (a, b) =>
          (b.sortTime || Date.parse(b.date) || 0) -
          (a.sortTime || Date.parse(a.date) || 0)
      );
      setEmails(sortedEmails);
      setNextPageToken(response.data.nextPageToken || null);
    } catch (err) {
      setError(getErrorMessage(err));
      setEmails([]);
    } finally {
      setLoading(false);
    }
  }, [endpoint, params]);

  useEffect(() => {
    // The loader synchronizes this client view with the Express Gmail API.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadEmails();
  }, [loadEmails]);

  function updateFilter(event) {
    setFilters((current) => ({
      ...current,
      [event.target.name]: event.target.value,
    }));
    setPageTokens([null]);
    setPageIndex(0);
  }

  function selectInboxCategory(category) {
    setInboxCategory(category);
    setPageTokens([null]);
    setPageIndex(0);
  }

  async function markRead(id) {
    await api.patch(`/api/gmail/read/${id}`);
    setEmails((current) =>
      current.map((email) =>
        email.id === id ? { ...email, unread: false } : email
      )
    );
  }

  async function deleteEmail(id) {
    await api.delete(`/api/gmail/delete/${id}`);
    setEmails((current) => current.filter((email) => email.id !== id));
  }

  function nextPage() {
    if (!nextPageToken) return;
    setPageTokens((current) => [
      ...current.slice(0, pageIndex + 1),
      nextPageToken,
    ]);
    setPageIndex((current) => current + 1);
  }

  function connectGmail() {
    window.location.assign("/api/auth/google");
  }

  return (
    <AppShell>
      <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Real Gmail messages from the connected account.
          </p>
        </div>
        <form className="grid gap-2 sm:grid-cols-3">
          <input
            name="subject"
            value={filters.subject}
            onChange={updateFilter}
            placeholder="Subject"
            className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-red-400"
          />
          <input
            name="sender"
            value={filters.sender}
            onChange={updateFilter}
            placeholder="Sender"
            className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-red-400"
          />
          <input
            name="date"
            type="date"
            value={filters.date}
            onChange={updateFilter}
            className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-red-400"
          />
        </form>
      </div>

      {isInbox && (
        <div className="mb-4 overflow-hidden rounded-md border border-zinc-200 bg-white">
          <div className="overflow-x-auto">
            <div className="grid min-w-[640px] grid-cols-5">
              {inboxCategories.map((category) => {
                const active = inboxCategory === category.key;
                return (
                  <button
                    key={category.key}
                    type="button"
                    onClick={() => selectInboxCategory(category.key)}
                    className={`border-b-2 px-4 py-4 text-left text-sm font-medium ${
                      active
                        ? "border-red-600 bg-red-50 text-red-700"
                        : "border-transparent text-zinc-600 hover:bg-zinc-50 hover:text-zinc-950"
                    }`}
                  >
                    {category.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}{" "}
          <button
            type="button"
            onClick={connectGmail}
            className="font-medium underline"
          >
            Connect Gmail
          </button>
        </div>
      )}

      <EmailTable
        emails={emails}
        loading={loading}
        onDelete={deleteEmail}
        onMarkRead={markRead}
      />

      <div className="mt-4 flex items-center justify-between">
        <button
          type="button"
          disabled={pageIndex === 0}
          onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
          className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          Previous
        </button>
        <span className="text-sm text-zinc-500">Page {pageIndex + 1}</span>
        <button
          type="button"
          disabled={!nextPageToken}
          onClick={nextPage}
          className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </AppShell>
  );
}
