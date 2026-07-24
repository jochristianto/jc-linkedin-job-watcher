import { useCallback, useEffect, useRef, useState } from "react";

import { BLOCK_CONFIRM_MS } from "@/view-model.ts";

/**
 * The Block confirmation: which row's Block button is currently asking "Sure?".
 *
 * Blocking takes two presses because it hides every future job from a company
 * and the row it was pressed on stays put, greyed — so a mis-click looks like
 * nothing much happened, and you find out weeks later by the jobs you never saw.
 * Unblocking is single-press: it can only put jobs back.
 *
 * At most one row is ever armed — arming a second disarms the first, so two
 * buttons can never be asking at once — and the question answers itself with
 * "no" after {@link BLOCK_CONFIRM_MS}, so a click you meant for the row
 * underneath can't leave a live one-press-to-block button lying around.
 *
 * Deliberately not persisted: a question you walked away from should not still
 * be waiting when you reopen the popup.
 */
export function useArmedBlock(): {
  armedBlockId: string | null;
  arm: (id: string) => void;
  disarm: () => void;
} {
  const [armedBlockId, setArmedBlockId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const disarm = useCallback(() => {
    clearTimeout(timer.current);
    setArmedBlockId(null);
  }, []);

  const arm = useCallback((id: string) => {
    clearTimeout(timer.current);
    setArmedBlockId(id);
    timer.current = setTimeout(() => setArmedBlockId(null), BLOCK_CONFIRM_MS);
  }, []);

  // A popup that closes mid-question leaves the timeout behind otherwise.
  useEffect(() => () => clearTimeout(timer.current), []);

  return { armedBlockId, arm, disarm };
}
