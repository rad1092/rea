/** Experimental static profile; these limits do not alter the default process adapter. */
export const JAVASCRIPT_THREAD_LIMITS = {
  heapMb: 256,
  timeoutMs: 5_000,
  sourceBytes: 4 * 1024 * 1024,
  checkpointBytes: 2 * 1024 * 1024,
  transferBytes: 8 * 1024 * 1024,
  resultRetentionBytes: 64 * 1024 * 1024,
  protocolBytes: 64 * 1024,
  outputBytes: 64 * 1024,
} as const;
