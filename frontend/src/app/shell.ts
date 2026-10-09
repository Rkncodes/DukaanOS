import { useOutletContext } from "react-router";

/** What the app's frame offers the page inside it. */
export type ShellContext = {
  /** Opens the Salaahkaar panel, the same one as the top bar's button. */
  openAssistant: () => void;
};

/** The frame's context, or undefined when a page is rendered on its own (tests). */
export function useShell(): ShellContext | undefined {
  return useOutletContext<ShellContext | undefined>() ?? undefined;
}
