import type { AnnotationRecord } from "../../../shared/review/annotation-record.ts";
/** Fetch a bounded complete snapshot before a caller replaces links or marks a
 * receipt version displayed. A failed Nth read leaves the version retryable. */
export async function candidateAnnotations(
  publication: { policy: { space: string }; createdIds: string[] } | null,
  read: (space: string, id: string) => Promise<AnnotationRecord>,
) {
  if (!publication) return [];
  if (
    !Array.isArray(publication.createdIds) ||
    publication.createdIds.length > 8 ||
    new Set(publication.createdIds).size !== publication.createdIds.length
  )
    throw Error("Invalid candidate receipt");
  const records: AnnotationRecord[] = [];
  for (const id of publication.createdIds) {
    const record = await read(publication.policy.space, id);
    if (
      record.id !== id ||
      record.space !== publication.policy.space ||
      record.deleted
    )
      throw Error("Candidate annotation identity changed");
    records.push(record);
  }
  return records;
}
