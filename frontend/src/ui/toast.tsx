import { Toaster as SonnerToaster, toast } from "sonner";
import { errorMessage } from "@/api/client";

export { toast };

/** Toasts confirm what happened ("Saved", "Download approved"). Errors stay until dismissed. */
export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      offset={20}
      mobileOffset={{ bottom: 84 }}
      toastOptions={{
        classNames: {
          toast: "!rounded-lg !border !border-line !bg-surface !text-ink !shadow-pop !font-sans",
          description: "!text-ink-3",
          actionButton: "!bg-brand !text-white",
          error: "!border-block-line",
        },
      }}
    />
  );
}

export function toastError(err: unknown, title = "That did not work") {
  toast.error(title, { description: errorMessage(err), duration: 8000 });
}
