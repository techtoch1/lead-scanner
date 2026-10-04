// Reads a password from stdin and prints a LOGIN_HASH value for /etc/lead-scanner.env.
//   printf '%s' 'the password' | node hash-password.js
import { hashPassword } from './auth.js';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const password = input.replace(/\r?\n$/, '');
if (password.length < 10) {
  console.error('Password must be at least 10 characters.');
  process.exit(1);
}
console.log(hashPassword(password));
