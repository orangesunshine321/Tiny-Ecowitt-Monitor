import { readFileSync } from 'node:fs';
import { sshExec } from './sshExec.ts';
const S = process.argv[2]!;
const base = { host: '127.0.0.1', port: 2222, username: 'root', privateKey: readFileSync(`${S}/client_ed25519`), hostKey: readFileSync(`${S}/host_ed25519.pub`, 'utf8') };
for (const c of ['sensors -j', 'uptime', 'cat /etc/shadow']) console.log(c, '=>', JSON.stringify(await sshExec(base, c)));
