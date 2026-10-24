import { Linking } from 'react-native';
import { appApiOrigin } from './api';

/**
 * Opens the one-time download link of an export (`/auth/exports/{token}`, API-relative). Native
 * hands the absolute address to the system, whose browser downloads the file: there is no file
 * store in the app yet, and the link is the credential, so it is opened at once and never kept.
 */
export function openExportDownload(path: string): void {
  const origin = appApiOrigin();
  if (origin.ok) void Linking.openURL(new URL(path, origin.baseUrl).href);
}
