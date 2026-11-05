// Тимчасовий пароль укладача: CSPRNG, 16 символів без схожих на вигляд (0/O, 1/l/I),
// бо адмін передає його людині особисто. Політика realm вимагає щонайменше 10 символів.
import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export const TEMPORARY_PASSWORD_LENGTH = 16;

export function generateTemporaryPassword(length = TEMPORARY_PASSWORD_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}
