import { createAcpExtension } from "./index.js";

/**
 * Pidian's SDK Host entry point.
 *
 * Pidian loads the extension in a headless JSON runtime. The context manager
 * remains active, while optional self-update and delegate features stay under
 * the host that owns them instead of starting network or child-process work
 * inside the SDK Host.
 */
export default createAcpExtension({
  autoUpdate: false,
  delegate: false,
  rules: false,
});
