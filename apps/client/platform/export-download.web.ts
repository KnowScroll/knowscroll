/**
 * Web: the link answers `Content-Disposition: attachment`, so navigating to it downloads the
 * file and leaves the page where it is. The link is the credential and goes unused otherwise.
 */
export function openExportDownload(path: string): void {
  window.location.assign(path);
}
