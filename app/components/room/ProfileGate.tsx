import { ProfileFields } from "~/components/ProfileFields";
import type { ConfirmedProfile } from "~/model/peer.model";

export function ProfileGate({
  draft,
  onDraftChange,
  onConfirm,
  userAgent,
}: {
  draft: ConfirmedProfile | undefined;
  onDraftChange: (profile: ConfirmedProfile) => void;
  onConfirm: () => void;
  userAgent: string;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onConfirm();
      }}
      className="surface-panel flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-gray-200 p-5 dark:border-gray-700"
    >
      <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200">
        Confirm your profile before joining
      </h2>
      {draft && (
        <ProfileFields profile={draft} onChange={onDraftChange} userAgent={userAgent} />
      )}
      <button
        type="submit"
        disabled={!draft}
        className="rounded-full bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
      >
        Join room
      </button>
    </form>
  );
}
