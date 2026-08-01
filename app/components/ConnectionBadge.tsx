import type { ConnectionType } from "~/model/connection.model";

const connectionMap: Record<
  ConnectionType,
  { label: string; className: Record<"badge" | "legend", string> }
> = {
  DIRECT: {
    label: "Direct Connection",
    className: {
      badge: "rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
      legend: "surface-panel -mb-3.5 z-1 rounded-lg border border-gray-200 dark:border-gray-700 text-emerald-800 dark:text-emerald-300",
    },
  },
  RELAY: {
    label: "Relayed via TURN",
    className: {
      badge: "rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
      legend: "surface-panel -mb-3.5 z-1 rounded-lg border border-gray-200 dark:border-gray-700 text-amber-800 dark:text-amber-300",
    },
  },
  UNKNOWN: {
    label: "Connection type Unknown",
    className: {
      badge: "rounded-full bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
      legend: "surface-panel -mb-3.5 z-1 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300",
    },
  },
};

export function ConnectionBadge({
  type,
  variant = "badge",
}: {
  type: ConnectionType;
  variant?: "badge" | "legend";
}) {
  const { label, className } = connectionMap[type];
  return (
    <span
      className={`inline-flex w-fit items-center px-3 py-1 text-xs font-medium ${className[variant]}`}
    >
      {label}
    </span>
  );
}
