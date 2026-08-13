/**
 * @shapeoko/ui — React kiosk UI for the Shapeoko controller.
 *
 * This package is intentionally a scaffold only. The real kiosk screens for the
 * 7" 1024x600 DSI panel (Chromium kiosk mode) are added in later issues. No
 * machine screens or runtime wiring live here yet — just a trivial component so
 * the workspace typechecks, tests, and builds meaningfully green.
 */
import type { ReactElement } from 'react';

/** Canonical package name for the kiosk UI workspace. */
export const UI_PACKAGE_NAME = '@shapeoko/ui';

/** Placeholder root component. Real kiosk screens arrive in later issues. */
export function App(): ReactElement {
  return <div className="shapeoko-app">Shapeoko Controller</div>;
}
