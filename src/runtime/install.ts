/**
 * How `omar` gets onto a machine that has none.
 *
 * The extension does not carry the runtime; it runs the runtime's own
 * installer in a terminal on the extension host, in the open, so the
 * operator sees what it does and answers its questions. No vscode here.
 */

export const INSTALL_URL = "https://omar.rs/install.sh";

/** The command to run, or null where the installer does not go. */
export function installCommandFor(platform: NodeJS.Platform): string | null {
  switch (platform) {
    case "darwin":
    case "linux":
      // The script puts omar and omarc in /usr/local/bin, and asks for sudo
      // itself when it needs it.
      return `curl -fsSL ${INSTALL_URL} | sh`;
    default:
      return null;
  }
}

/** Whether a spawn failure means the binary is not there, as against failing to run. */
export function isMissingBinary(failure: string): boolean {
  return /ENOENT/.test(failure);
}
