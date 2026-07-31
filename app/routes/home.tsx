import { useState, type SubmitEvent } from "react";
import { Link, useNavigate } from "react-router";
import { ProfileFields } from "~/components/ProfileFields";
import { useProfileDraft } from "~/hooks/confirmed-profile.hook";
import { resolveJoinInput, tokenToSlug } from "~/lib/room-token";

import type { Route } from "./+types/home";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "P2P Speedtest" },
    {
      name: "description",
      content: "Measure the real network connection between two devices.",
    },
  ];
}

const USER_AGENT = typeof navigator !== "undefined" ? navigator.userAgent : "";

export default function Home() {
  const navigate = useNavigate();
  const { draft: profile, setDraft: setProfile, persist: confirmProfile } = useProfileDraft(USER_AGENT);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [joinInput, setJoinInput] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);

  async function handleCreate() {
    if (!profile?.name.trim()) {
      setCreateError("Enter a name before creating a room.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const resp = await fetch("/api/rooms", { method: "POST" });
      if (!resp.ok) {
        throw new Error(
          resp.status === 429
            ? "Too many rooms created recently. Try again in a minute."
            : `Could not create a room (${resp.status}).`,
        );
      }
      const { slug } = (await resp.json()) as { slug: string };
      const confirmed = confirmProfile();
      navigate(`/room/${slug}`, { state: { profile: confirmed } });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  function handleJoin(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile?.name.trim()) {
      setJoinError("Enter a name before joining a room.");
      return;
    }
    const token = resolveJoinInput(joinInput);
    if (token === null) {
      setJoinError("That doesn't look like a Room ID, emoji key, or link.");
      return;
    }
    setJoinError(null);
    const confirmed = confirmProfile();
    navigate(`/room/${tokenToSlug(token)}`, { state: { profile: confirmed } });
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-10 px-4 py-16">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
          P2P Speedtest
        </h1>
        <p className="max-w-sm text-sm text-gray-600 dark:text-gray-400">
          Measure the real connection between two devices, peer to peer.
        </p>
      </div>

      <div className="flex w-full max-w-sm flex-col gap-6">
        <section className="flex flex-col gap-2 rounded-2xl border border-gray-200 p-5 dark:border-gray-700">
          <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200">
            Your profile
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Confirmed once here, then used whether you create or join below.
          </p>
          {profile && (
            <ProfileFields
              profile={profile}
              onChange={setProfile}
              userAgent={USER_AGENT}
            />
          )}
        </section>

        <section className="flex flex-col gap-2 rounded-2xl border border-gray-200 p-5 dark:border-gray-700">
          <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200">
            Create a test
          </h2>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="rounded-full bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
          >
            {creating ? "Creating…" : "Create a room"}
          </button>
          {createError && (
            <p className="text-sm text-red-600 dark:text-red-400">
              {createError}
            </p>
          )}
        </section>

        <section className="flex flex-col gap-2 rounded-2xl border border-gray-200 p-5 dark:border-gray-700">
          <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200">
            Join a test
          </h2>
          <form onSubmit={handleJoin} className="flex flex-col gap-2">
            <input
              type="text"
              value={joinInput}
              onChange={(e) => setJoinInput(e.target.value.toUpperCase())}
              placeholder="Room ID, emoji key, or link"
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              autoCapitalize="characters"
            />
            <button
              type="submit"
              className="rounded-full border border-gray-300 px-4 py-2 text-sm font-medium text-gray-900 dark:border-gray-600 dark:text-gray-100"
            >
              Join
            </button>
          </form>
          {joinError && (
            <p className="text-sm text-red-600 dark:text-red-400">
              {joinError}
            </p>
          )}
        </section>

        <Link
          to="/results"
          className="self-center text-sm text-gray-500 underline dark:text-gray-400"
        >
          View past results
        </Link>
      </div>
    </main>
  );
}
