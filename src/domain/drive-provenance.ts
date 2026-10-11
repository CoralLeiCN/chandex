export interface DriveProvenance {
  provider: "google-drive";
  id: string;
  name: string;
  mimeType: string;
  version: string;
  modifiedTime: string;
  size?: string;
  md5Checksum?: string;
  exportMimeType?: string;
  representation: "binary" | "workspace-export";
  sha256: string;
}
const exports: Record<string, string> = {
  "application/vnd.google-apps.document":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.google-apps.spreadsheet":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.google-apps.presentation":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
export function safeDriveProvenance(
  value: DriveProvenance,
  byteHash: string,
): DriveProvenance {
  if (
    value.provider !== "google-drive" ||
    typeof value.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(value.id) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 1000 ||
    /[\x00-\x1f\x7f]/.test(value.name) ||
    typeof value.mimeType !== "string" ||
    !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(value.mimeType) ||
    value.mimeType.length > 200 ||
    typeof value.version !== "string" ||
    !/^\d{1,64}$/.test(value.version) ||
    typeof value.modifiedTime !== "string" ||
    value.modifiedTime.length > 40 ||
    !Number.isFinite(Date.parse(value.modifiedTime)) ||
    value.sha256 !== byteHash
  )
    throw Error("Invalid Google Drive snapshot provenance.");
  const common = {
    provider: "google-drive" as const,
    id: value.id,
    name: value.name,
    mimeType: value.mimeType,
    version: value.version,
    modifiedTime: value.modifiedTime,
    sha256: byteHash,
  };
  if (
    value.representation === "workspace-export" &&
    exports[value.mimeType] === value.exportMimeType
  )
    return {
      ...common,
      representation: "workspace-export",
      exportMimeType: value.exportMimeType,
    };
  if (
    value.representation !== "binary" ||
    value.mimeType.startsWith("application/vnd.google-apps.") ||
    value.exportMimeType !== undefined ||
    typeof value.size !== "string" ||
    !/^\d{1,20}$/.test(value.size) ||
    BigInt(value.size) < 1n ||
    BigInt(value.size) > 25n * 1024n * 1024n ||
    typeof value.md5Checksum !== "string" ||
    !/^[a-f0-9]{32}$/.test(value.md5Checksum)
  )
    throw Error("Invalid Google Drive snapshot provenance.");
  return {
    ...common,
    representation: "binary",
    size: value.size,
    md5Checksum: value.md5Checksum,
  };
}
