import { Component, type ReactNode } from "react";

/**
 * A page that fails says so.
 *
 * React unmounts everything when a render throws, which leaves a webview
 * black with nothing to read. This catches the throw and prints it where
 * the page was, so the failure is a sentence rather than a blank.
 */
export class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="page-error">
          <b>This view failed to draw.</b>
          <pre>{this.state.error}</pre>
          <p>Reload the window (Developer: Reload Window) and, if it happens again, report it with the text above.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
