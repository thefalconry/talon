/**
 * Per-device mesh credentials — barrel. The store (persistence + lifecycle),
 * the token format, the scope vocabulary, and the operator surface.
 */

export { DeviceCredentialStore } from "./store.js";
export { credentialIdOf, isDeviceCredentialToken } from "./token.js";
export {
  DEFAULT_COMPANION_SCOPES,
  FORMER_COMPANION_SCOPES,
  NODE_SCOPES,
  type CredentialOrigin,
  type DeviceCredential,
  type MeshScope,
} from "./types.js";
export {
  credentialAdmin,
  credentialOverview,
  type CredentialAdminContext,
} from "./admin.js";
