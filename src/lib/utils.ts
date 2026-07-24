import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn's class merger: `clsx` for the conditionals, `tailwind-merge` to make
 *  a later utility win over an earlier one in the same group — so a caller's
 *  `className="bg-card"` actually overrides a component's own `bg-background`
 *  instead of the pair fighting on specificity. Every registry component in
 *  `components/ui/` imports this, which is why it lives at shadcn's exact path. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
