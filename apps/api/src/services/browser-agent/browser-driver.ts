// Keep third-party browser bindings behind one local module so the agent can
// swap drivers without touching the planner/fill/observe layers.
export {
  chromium,
  type Browser,
  type BrowserContext,
  type Dialog,
  type FileChooser,
  type Frame,
  type Locator,
  type Page
} from "playwright-core";
