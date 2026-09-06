import { verifyCommittedUiAssets } from "./build-next-ui.mjs";

await verifyCommittedUiAssets();

console.log("Committed UI assets match the manifest and security policy.");
