/**
 * Tauri native notification wrapper.
 * Requires: tauri-plugin-notification in Cargo.toml + "notification:default" in capabilities/default.json
 * Install: npm run tauri add notification
 *
 * Silently skips if permission is denied — manager will still see the Realtime pane.
 */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';

export async function sendManagerNotification(title: string, body: string): Promise<void> {
  let permissionGranted = await isPermissionGranted();
  if (!permissionGranted) {
    const permission = await requestPermission();
    permissionGranted = permission === 'granted';
  }
  if (!permissionGranted) return; // silently skip — manager will see Realtime pane
  sendNotification({ title, body });
}
