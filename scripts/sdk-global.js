// The IIFE build's view of @runappsai/sdk: the page's global `RunApps`
// (https://www.runapps.ai/sdk/latest.js hangs every export on it).
const sdk = globalThis.RunApps;
if (!sdk) throw new Error("@runappsai/agent: load https://www.runapps.ai/sdk/latest.js before agent.umd.js");
export const RunApps = sdk;
export const APIError = sdk.APIError;
export default sdk;
