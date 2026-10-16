// Shared by the browser UI and the local Node service. Keep the cap below the
// ZIP32 sentinel so no valid size or offset field needs ZIP64 extensions.
export const MAX_RESULTS_ARCHIVE_BYTES = 0xfffffffe;
export const RESULTS_ARCHIVE_SIZE_LABEL = 'чуть меньше 4 ГБ';
export const RESULTS_ARCHIVE_TOO_LARGE_MESSAGE = `Максимальный размер архива — ${RESULTS_ARCHIVE_SIZE_LABEL}`;

const ZIP32_MAX_VALUE = 0xffffffff;
const ZIP32_END_RECORD_BYTES = 22;

export function calculateZip32ArchiveLayout(localRecordsBytes, centralDirectoryBytes, entryCount,
  maxBytes = MAX_RESULTS_ARCHIVE_BYTES) {
  for (const value of [localRecordsBytes, centralDirectoryBytes, entryCount, maxBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Некорректный размер ZIP-архива');
  }
  // 0xffff is the ZIP64 sentinel in the classic end-of-directory record.
  if (entryCount >= 0xffff) throw new Error('Слишком много файлов в ZIP-архиве');
  if (localRecordsBytes > ZIP32_MAX_VALUE || centralDirectoryBytes > ZIP32_MAX_VALUE) {
    throw new Error(RESULTS_ARCHIVE_TOO_LARGE_MESSAGE);
  }
  const archiveBytes = localRecordsBytes + centralDirectoryBytes + ZIP32_END_RECORD_BYTES;
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes > Math.min(maxBytes, MAX_RESULTS_ARCHIVE_BYTES)) {
    throw new Error(RESULTS_ARCHIVE_TOO_LARGE_MESSAGE);
  }
  return { centralDirectoryOffset: localRecordsBytes, archiveBytes };
}
