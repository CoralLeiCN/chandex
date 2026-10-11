export function sourceViewer(source: any) {
  const revision = source.revisions.find(
      (r: any) => r.id === source.current_revision,
    ),
    passages = source.passages.filter(
      (p: any) => p.revisionId === source.current_revision,
    );
  if (source.removed || !passages.length)
    throw new Error("This source is no longer available. Search again.");
  return {
    title: source.title,
    warnings: revision?.warnings ? JSON.parse(revision.warnings) : [],
    passages,
    source,
    derivedFrom: source.derived_from,
    provenance: revision && {
      revisionId: revision.id,
      origin: revision.origin,
      requestedOrigin: revision.requested_origin,
      retrievedAt: revision.retrieved_at,
      originalHash: revision.hash,
      extractionVersion: revision.extractor,
      drive: revision.provider_metadata
        ? JSON.parse(revision.provider_metadata)
        : null,
    },
  };
}

export function audioTechnicalWarning(warning: string) {
  return /^(Automatic English transcript:|Decoded (?:WAV|MP3|M4A AAC-LC|ADTS AAC-LC|FLAC|VORBIS|OPUS):|Recognition (?:uses the decoded|resamples ))/.test(
    warning,
  );
}
