import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import type { DriveConnectionStatus } from "../connectors/drive-connection.ts";

export function DriveControls({
  onStatus,
}: {
  onStatus?: (status: DriveConnectionStatus) => void;
}) {
  const [status, setStatus] = useState<DriveConnectionStatus | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0);
  const update = (value: DriveConnectionStatus) => {
    setStatus(value);
    onStatus?.(value);
  };
  useEffect(() => {
    const own = ++generation.current;
    void api("/drive")
      .then((value) => {
        if (generation.current === own) update(value);
      })
      .catch((e) => {
        if (generation.current === own) setError(e.message);
      });
    return () => {
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (status?.state !== "connecting" || busy) return;
    let active = true;
    const timer = setInterval(() => {
      const own = generation.current;
      void api("/drive")
        .then((value) => {
          if (active && generation.current === own) update(value);
        })
        .catch((e) => {
          if (active && generation.current === own) setError(e.message);
        });
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [status?.state, busy]);
  const action = async (verb: "connect" | "disconnect") => {
    const own = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const value = await api("/drive/" + verb, "POST", {});
      if (generation.current === own) update(value);
    } catch (e) {
      if (generation.current === own) {
        setError(e instanceof Error ? e.message : "Drive connection failed.");
        try {
          update(await api("/drive"));
        } catch {}
      }
    } finally {
      if (generation.current === own) setBusy(false);
    }
  };
  return (
    <section className="drive-connection" aria-label="Google Drive connection">
      <p aria-live="polite">
        {status?.state === "connected"
          ? "Google Drive is connected."
          : status?.state === "connecting"
            ? "Complete Google consent in your external browser, then return here."
            : status?.state === "unavailable"
              ? "Google Drive is not configured on this computer."
              : status
                ? "Google Drive is disconnected."
                : "Checking Google Drive…"}
      </p>
      <p className="fine">
        Connecting grants read-only access to your Drive files. Choose the
        Google account in your external browser. Codeboom imports only the file
        you select; saved snapshots stay in this notebook after disconnecting.
      </p>
      {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
      {status?.configured && (
        <button
          type="button"
          className="small"
          disabled={busy}
          onClick={() =>
            void action(
              status.state === "disconnected" ? "connect" : "disconnect",
            )
          }
        >
          {busy
            ? "Working…"
            : status.state === "disconnected"
              ? "Connect Google Drive"
              : status.state === "connecting"
                ? "Cancel connection"
                : "Disconnect Google Drive"}
        </button>
      )}
      {status?.state === "connected" && (
        <p className="fine">
          Disconnect removes Codeboom’s stored access. You can also revoke its
          grant in your Google account.
        </p>
      )}
    </section>
  );
}
