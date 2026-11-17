import { useDevicePreferences } from '../../providers/device-preferences';
import { EVERY_READER, EVERY_READER_FOLIO, type ScrollReaderKind } from './scroll-readers';

/**
 * Every reader, with the v2 reader this device chose in Accessibility & playback (Folio's trial, #732). A constant list
 * per choice, so a session built from it is rebuilt only when the choice changes.
 */
export function useScrollReaders(): readonly ScrollReaderKind[] {
  const { preferences } = useDevicePreferences();
  return preferences.scrollReader === 'folio' ? EVERY_READER_FOLIO : EVERY_READER;
}
