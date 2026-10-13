import { spawn } from 'node:child_process';

export class UpstreamClient {
  #child; #pending = new Map(); #id = 0; #buffer = Buffer.alloc(0); #dead = false; #onFatal;
  constructor({command, args, env, cwd, onFatal}) {
    this.#onFatal=onFatal;
    this.stderr = '';
    this.#child = spawn(command, args, {env, cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: false});
    this.closed = new Promise(resolve=>this.#child.once('close',(code,signal)=>resolve({code,signal})));
    this.#child.stdout.on('data', chunk => this.#receive(chunk));
    this.#child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-4096); });
    this.#child.once('error', error => this.#fail(error));
    this.#child.once('exit', (code, signal) => this.#fail(new Error(`Restricted upstream exited (${code ?? signal}): ${this.stderr}`)));
  }
  #receive(chunk) {
    if (this.#buffer.length + chunk.length > 8 * 1024 * 1024) { this.close('Upstream frame exceeds 8 MiB'); return; }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const i = this.#buffer.indexOf(10);
      if (i < 0) break;
      const line = this.#buffer.subarray(0, i); this.#buffer = this.#buffer.subarray(i + 1);
      if (!line.length) continue;
      let message;
      try { message = JSON.parse(line.toString('utf8')); }
      catch { this.close('Upstream sent invalid JSON'); return; }
      const entry = this.#pending.get(message.id);
      if (!entry) continue;
      this.#pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message ?? 'Upstream RPC error'));
      else entry.resolve(message.result);
    }
  }
  #fail(error) {
    if(this.#dead) return;
    this.#dead = true;
    for (const entry of this.#pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.#pending.clear();
    this.#onFatal?.(error);
  }
  request(method, params = {}, timeoutMs = 15000) {
    if (this.#dead) return Promise.reject(new Error('Session invalidated; restart the wrapper.'));
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close('Operation timed out; session invalidated.'), timeoutMs);
      this.#pending.set(id, {resolve, reject, timer});
      this.#child.stdin.write(JSON.stringify({jsonrpc:'2.0', id, method, params}) + '\n');
    });
  }
  notify(method, params = {}) {
    if (!this.#dead) this.#child.stdin.write(JSON.stringify({jsonrpc:'2.0', method, params}) + '\n');
  }
  endInput() {
    if(!this.#child.stdin.destroyed) this.#child.stdin.end();
  }
  async shutdown() {
    this.endInput();
    const term=setTimeout(()=>this.#child.kill('SIGTERM'),1000);
    const kill=setTimeout(()=>this.#child.kill('SIGKILL'),2000);
    try {return await this.closed;} finally {clearTimeout(term);clearTimeout(kill);}
  }
  close(reason = 'Session closed') {
    this.#fail(new Error(reason));
    // No PID discovery or ambient process inspection. Production sandbox denies
    // all process-fork operations; terminating this owned process also destroys
    // its Worker Threads. This client alone is not a subprocess-tree sandbox.
    this.#child.kill('SIGKILL');
  }
}
