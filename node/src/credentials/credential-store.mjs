import { FileCredentialStore } from "./file-credential-store.mjs";
import { NativeKeyringStore } from "./native-keyring.mjs";
import { getPaths } from "../shared/paths.mjs";
import { CrpError } from "../shared/errors.mjs";

function backendInvalid() {
  return new CrpError(
    "CREDENTIAL_BACKEND_INVALID",
    "The credential backend is invalid.",
    "Choose the native or file credential backend.",
    { status: 400 }
  );
}

function fallbackConsentRequired() {
  return new CrpError(
    "CREDENTIAL_FALLBACK_CONSENT_REQUIRED",
    "File credential storage requires explicit consent.",
    "Confirm file fallback storage before trying again.",
    { status: 400 }
  );
}

function backendUnavailable(cause) {
  return new CrpError(
    "CREDENTIAL_BACKEND_UNAVAILABLE",
    "The credential backend is unavailable.",
    "Check the native credential service or explicitly consent to file fallback storage.",
    { status: 500, cause }
  );
}

function asBackendUnavailable(error) {
  if (error instanceof CrpError && error.code === "CREDENTIAL_BACKEND_UNAVAILABLE") {
    return error;
  }
  return backendUnavailable(error);
}

function createFileStore(paths, fileStoreFactory) {
  try {
    return fileStoreFactory({ path: paths.secretFallbackPath });
  } catch (error) {
    if (error instanceof CrpError) throw error;
    throw backendUnavailable(error);
  }
}

export function createCredentialStore({
  backend = "native",
  fallbackConsent = false,
  paths = getPaths(),
  nativeStoreFactory = () => new NativeKeyringStore(),
  fileStoreFactory = (options) => new FileCredentialStore(options)
} = {}) {
  if (backend !== "native" && backend !== "file") throw backendInvalid();

  if (backend === "file") {
    if (fallbackConsent !== true) throw fallbackConsentRequired();
    return createFileStore(paths, fileStoreFactory);
  }

  let nativeStore;
  try {
    nativeStore = nativeStoreFactory();
  } catch (error) {
    if (fallbackConsent !== true) throw asBackendUnavailable(error);
    return createFileStore(paths, fileStoreFactory);
  }
  return nativeStore;
}
