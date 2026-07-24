import { CircleAlert, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import type { HealthState } from "@/types.ts";

export type BannerSeverity = NonNullable<HealthState["severity"]>;

/**
 * A one-line banner above the list: the scan health signal (PRD §16.8), and the
 * §16.7 "push has been failing" warning that stacks under it.
 *
 * shadcn's Alert ships `default` and `destructive`; the amber `warn` tier is
 * this app's own, so it is applied as a className rather than by editing
 * `ui/alert.tsx` — those files are registry output and re-running the shadcn CLI
 * would overwrite an extra variant added there.
 */
export function HealthBanner({
  message,
  severity,
  className,
}: {
  message: string;
  severity: BannerSeverity;
  className?: string;
}) {
  const error = severity === "error";
  const Icon = error ? TriangleAlert : CircleAlert;
  return (
    <Alert
      data-severity={severity}
      variant={error ? "destructive" : "default"}
      className={cn(
        "rounded-none border-x-0 border-t-0 px-3 py-2",
        error
          ? "bg-destructive-weak/60"
          : "bg-warn-weak/70 text-warn [&>svg]:text-warn",
        className,
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      <AlertDescription className="text-xs leading-snug text-current">
        {message}
      </AlertDescription>
    </Alert>
  );
}
