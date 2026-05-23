/**
 * Client-side file-download helper. Used by view [D]/[D-Deep] Download buttons
 * to convert a server response into a browser-driven file save (Stage 4).
 *
 * The download endpoints stream MD/HTML content directly; we build a Blob URL
 * and trigger a programmatic `<a download>` click. The URL is revoked on the
 * next tick to avoid leaking object URLs.
 */

export interface DownloadPayload {
  filename: string;
  mimeType: string;
  body: string;
}

/**
 * Trigger a browser file save for the given payload. Safe to call from event
 * handlers. No-op on the server (where `document` is undefined).
 */
export function triggerDownload(payload: DownloadPayload): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([payload.body], { type: payload.mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = payload.filename;
  // Hidden, not part of the document layout.
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after the current task so Chrome/Firefox have time to start the save.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
