/**
 * Whether this device is too short of memory for the 3D views from the start, so the tab opens as the
 * Simple lists (D-111). Native has no reading of the device's memory that the app can use, so it relies on
 * the system's own warning (`SpaceView` shows the lists when one arrives); the web reads the browser's
 * rounded figure (`low-memory-device.web.ts`).
 */
export const lowMemoryDevice = (): boolean => false;
