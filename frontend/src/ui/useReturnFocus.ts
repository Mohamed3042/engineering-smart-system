import { useLayoutEffect, useRef } from "react";

/**
 * Puts keyboard focus back where it was when a dialog opened. A dialog that is opened from state
 * (not from a Dialog trigger) otherwise drops focus to the top of the page when it closes. Focus is
 * only restored when it was really lost: if the page already moved it (to a new field, say) it stays.
 * When the opening button is gone (the mail was filed, so "File under a project" disappeared) focus
 * goes to the page heading instead of the top of the page.
 */
export function useReturnFocus(open: boolean) {
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    // Layout effects run before the dialog moves focus, so the active element is still the opener.
    if (open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return;
    }
    const el = opener.current;
    opener.current = null;
    if (!el) return;
    const t = window.setTimeout(() => {
      const now = document.activeElement;
      if (now && now !== document.body && now.isConnected) return;
      if (el.isConnected) {
        el.focus();
        return;
      }
      const heading = document.querySelector<HTMLElement>("h1");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus();
      }
    }, 40);
    return () => window.clearTimeout(t);
  }, [open]);
}
