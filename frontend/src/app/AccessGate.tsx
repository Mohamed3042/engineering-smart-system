import { useEffect, useState } from "react";
import { Button, Dialog, Field, Input } from "@/ui";

/**
 * When the server runs with ESS_ACCESS_TOKEN, API calls return 401 until the browser
 * holds the token. Ask for it once and keep it in a same-site cookie.
 */
export function AccessGate() {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener("ess:unauthorized", on);
    return () => window.removeEventListener("ess:unauthorized", on);
  }, []);
  const save = () => {
    document.cookie = `ess_token=${encodeURIComponent(token.trim())}; path=/; SameSite=Strict; max-age=31536000`;
    window.location.reload();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Access token required"
      description="This server is protected. Enter the access token that was set when it was started (ESS_ACCESS_TOKEN)."
      size="sm"
      footer={
        <Button onClick={save} disabled={!token.trim()}>
          Continue
        </Button>
      }
    >
      <Field label="Access token">
        <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && token.trim() && save()} />
      </Field>
    </Dialog>
  );
}
