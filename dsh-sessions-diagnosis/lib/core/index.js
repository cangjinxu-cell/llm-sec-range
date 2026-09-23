/**
 * Public surface of the `dsh-sessions-diagnosis` core library.
 *
 * The core is deliberately free of DSH imports: it is plain Node.js, so the same
 * code backs the DSH plugin, the standalone CLI, and the test suite. Where DSH's
 * own released codec is needed it is located and imported at runtime by
 * {@link module:dsh-sessions-diagnosis/core/format}.
 *
 * @module dsh-sessions-diagnosis/core
 */

export {
  CURRENT_FORMAT_VERSION,
  ADMITTED_MESSAGE_SOURCE_KINDS,
  MESSAGE_SLOTS,
  listSessions,
  parseSessionFormatLogFilename,
  readEntryHeader,
  resolveDshHome,
  resolveSessionsRoot,
  sessionFormatLogFilename,
  visitMessageSources
} from './store.js'

export {
  ZSTD_MAGIC,
  compressFrame,
  decodeSessionLog,
  decompressFrame,
  encodeSessionLog,
  readSessionHeader,
  readSessionLog,
  scanZstdFrames
} from './frames.js'

export {
  classifyMigrationFailure,
  probeMigration,
  resolveDshFormatModules
} from './format.js'

export { LOW_RISK_RULE_IDS, REPAIR_RULES, applyIssues, detectIssues, getRule } from './rules.js'

export { DIAGNOSIS_STATUSES, diagnoseEntry, diagnoseStore, loadSessionRows } from './diagnose.js'

export {
  REPAIR_MODES,
  checkContentPreserved,
  planRepair,
  readRepairManifest,
  repairSession,
  rollbackSession
} from './repair.js'

export {
  DEMO_ID_PREFIX,
  DEMO_MARKER_NAME,
  assertDemoStoreIsNotReal,
  buildDemoSession,
  createDemoSession,
  demoSessionId,
  demoSessionPath,
  findDemoSessions,
  freshDemoId,
  projectKey,
  readDemoMarker,
  removeDemoSessions,
  resolveDemoStore
} from './demo.js'
