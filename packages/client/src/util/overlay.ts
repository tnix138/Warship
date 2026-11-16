/**
 * A hard failure (no WebGL, missing asset, broken module) must be visible instead of
 * leaving the player with a black screen. This turns any uncaught error into a
 * readable overlay with the message and stack.
 *
 * The heading is Persian because a player may be looking at it; the body is left in
 * English because it is a stack trace, and a translated stack trace is useless to
 * whoever has to read it.
 */

let installed = false;

export function installErrorOverlay(): void {
  if (installed) return;
  installed = true;

  const show = (title: string, detail: string): void => {
    document.getElementById('boot-error')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'boot-error';

    const heading = document.createElement('h1');
    heading.textContent = title;

    const body = document.createElement('pre');
    body.textContent = detail;

    overlay.append(heading, body);
    document.body.append(overlay);
  };

  window.addEventListener('error', (event) => {
    show(
      'خطای کلاینت',
      event.error instanceof Error ? (event.error.stack ?? event.message) : event.message,
    );
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    show(
      'خطای پیش‌بینی‌نشده',
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
    );
  });
}
