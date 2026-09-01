/**
 * stdin/stdout interaction helpers for the CLI.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/**
 * Asks a yes/no question on stdout and reads the answer from stdin.
 *
 * @param question - The question text (appended with " [y/N]").
 * @param defaultYes - Default answer when the input is empty.
 * @returns True when the user answered yes.
 */
export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
    if (answer === '') {
      return defaultYes;
    }
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
