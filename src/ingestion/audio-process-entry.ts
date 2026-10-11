import { extract } from "./extract.ts";
import { MAX_BYTES } from "./url.ts";

if (!process.send) throw new Error("Audio extraction requires local IPC.");
process.once("message", async (message: unknown) => {
  try {
    if (
      !message ||
      typeof message !== "object" ||
      !Buffer.isBuffer((message as any).bytes)
    )
      throw new Error("Audio extraction received invalid input.");
    const bytes = (message as { bytes: Buffer }).bytes;
    if (bytes.length > MAX_BYTES) throw new Error("Source exceeds 25 MiB.");
    const result = await extract(bytes, "audio", (progress) =>
      process.send!({ progress }),
    );
    process.send!({ result });
  } catch (error) {
    process.send!({
      error:
        error instanceof Error ? error.message : "Audio extraction failed.",
    });
  }
});
// A parent crash must not leave native inference running without an owner.
process.once("disconnect", () => process.exit(1));
