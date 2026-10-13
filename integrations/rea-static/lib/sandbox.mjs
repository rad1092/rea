import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';

export const PIN = 'a6efa4fcefeffcf5ff5310b8154988b4be30c349';
export const NODE = realpathSync(process.execPath);
const quote = value => JSON.stringify(value);
export function sandboxProfile({read = [], write = []}) {
  if (process.platform !== 'darwin') throw new Error('This profile requires macOS sandbox-exec; no unsandboxed fallback.');
  const readable = [...new Set([dirname(dirname(NODE)), '/System/Library', '/usr/lib', ...read])];
  return `(version 1)
(deny default)
(allow process-exec (literal ${quote(NODE)}))
(allow signal (target self))
(allow sysctl-read)
(deny sysctl-read (sysctl-name-prefix "kern.proc"))
(allow file-read-metadata)
(allow file-read* (literal "/"))
(allow file-read* ${readable.map(p => `(subpath ${quote(p)})`).join(' ')})
(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/private/etc/localtime"))
(allow file-write* (literal "/dev/null") ${write.map(p => `(subpath ${quote(p)})`).join(' ')})
`;
}
export function cleanEnvironment(session) {
  return {
    PATH: '/usr/bin:/bin', HOME: `${session}/home`, TMPDIR: `${session}/tmp`,
    XDG_CACHE_HOME: `${session}/home/.cache`, XDG_CONFIG_HOME: `${session}/home/.config`,
    XDG_DATA_HOME: `${session}/home/.local/share`, LANG: 'en_US.UTF-8',
    REA_LOG_LEVEL: 'error', REA_MCP_MAX_RESPONSE_BYTES: '10485760',
    REA_STATIC_WORKER_THREADS: '1',
  };
}
