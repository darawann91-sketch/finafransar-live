// Usage: npm run create-admin -- lela@finafransar.com "Lela" admin
// Prompts for the password (not stored in shell history).
import { createInterface } from 'node:readline';
import { Hosts } from '../src/db.js';
import { hashPassword } from '../src/lib/crypto.js';

const [email, name = 'Admin', role = 'admin'] = process.argv.slice(2);
if (!email || !['admin', 'host'].includes(role)) {
  console.error('Användning: npm run create-admin -- <e-post> "<namn>" [admin|host]');
  process.exit(1);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.question('Lösenord (minst 12 tecken): ', (pw) => {
  rl.close();
  if (pw.length < 12) {
    console.error('För kort lösenord.');
    process.exit(1);
  }
  const existing = Hosts.byEmail(email);
  if (existing) {
    Hosts.update(existing.id, { passwordHash: hashPassword(pw), role, active: true, name });
    console.log(`Uppdaterade ${email} (${role}).`);
  } else {
    Hosts.create({ email, name, passwordHash: hashPassword(pw), role });
    console.log(`Skapade ${email} (${role}).`);
  }
});
