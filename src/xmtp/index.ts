export { createClaraXmtpClient, isXmtpInitialized } from './client.js';
export type { ClaraXmtpClientOptions } from './client.js';

export { encodeClaraMessage, decodeClaraMessage, isClaraMessage, extractText } from './content-types.js';
export type { ClaraMessagePayload } from './content-types.js';

export { ClaraIdentityCache } from './identity.js';
export type { ClaraIdentityEntry } from './identity.js';

export { ClaraGroupManager } from './groups.js';

export { getOrCreateEncryptionKey, getXmtpPaths } from './keys.js';

export { getOrInitXmtpClient, getIdentityCache } from './singleton.js';
