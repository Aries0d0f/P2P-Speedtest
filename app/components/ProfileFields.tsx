import { useRef } from "react";
import {
  PRIVACY_LEVELS,
  type ConfirmedProfile,
  type PrivacyLevel,
} from "~/model/peer.model";
import { defaultNameForLevel } from "~/lib/peer-profile";

const PRIVACY_COPY: Record<
  PrivacyLevel,
  { label: string; description: string }
> = {
  off: {
    label: "Off",
    description: "Share name, browser and device, full address, and location.",
  },
  on: {
    label: "On",
    description:
      "Share name, full address, and location. Browser and device withheld.",
  },
  anonymous: {
    label: "Anonymous",
    description:
      "Share name only. Address masked; location reduced to network type.",
  },
};

/**
 * The confirm step's fields (2.5, S3): name, editable, plus a privacy
 * level selector. Deliberately submit-less — callers (home's create/join
 * actions, room's direct-link gate) own what "confirm" means for them.
 */
export function ProfileFields({
  profile,
  onChange,
  userAgent,
}: {
  profile: ConfirmedProfile;
  onChange: (profile: ConfirmedProfile) => void;
  userAgent: string;
}) {
  // Whether the name has been hand-edited: switching privacy levels should
  // keep re-deriving the default name until the user actually types their
  // own, at which point a level switch must stop overwriting it.
  const nameEdited = useRef(false);

  async function handleLevelChange(level: PrivacyLevel) {
    const name = nameEdited.current
      ? profile.name
      : await defaultNameForLevel(level, userAgent);
      
    onChange({
      privacyLevel: level,
      name,
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label
          className="text-sm font-medium text-gray-700 dark:text-gray-200"
          htmlFor="profile-name"
        >
          Your name
        </label>
        <input
          id="profile-name"
          type="text"
          value={profile.name}
          onChange={(e) => {
            nameEdited.current = true;
            onChange({ ...profile, name: e.target.value });
          }}
          maxLength={60}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-200">
          Privacy
        </legend>
        <div className="flex flex-col gap-2">
          {PRIVACY_LEVELS.map((level) => (
            <label key={level} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="privacy-level"
                checked={profile.privacyLevel === level}
                onChange={() => handleLevelChange(level)}
                className="mt-1"
              />
              <span>
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {PRIVACY_COPY[level].label}
                </span>
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  {PRIVACY_COPY[level].description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
