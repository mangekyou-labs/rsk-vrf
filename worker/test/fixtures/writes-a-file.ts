// Control for the disk trap: tries to write a file in cwd.
import { writeFileSync } from 'node:fs';

try {
  writeFileSync('leak.txt', 'secret');
} catch {
  // The trap throws; it has already reported the attempt.
}
