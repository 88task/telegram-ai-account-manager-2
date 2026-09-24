import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import 'dotenv/config';

/**
 * Interactive CLI authorization tool for personal Telegram MTProto account.
 * Handles:
 * 1. Phone number
 * 2. Telegram SMS/App OTP
 * 3. 2FA Cloud Password (if enabled)
 */
async function authenticate() {
  const apiId = parseInt(process.env.TELEGRAM_API_ID || '', 10);
  const apiHash = process.env.TELEGRAM_API_HASH || '';

  if (!apiId || !apiHash) {
    console.error('ERROR: TELEGRAM_API_ID and TELEGRAM_API_HASH must be configured.');
    process.exit(1);
  }

  const stringSession = new StringSession('');
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  const rl = readline.createInterface({ input, output });

  console.log('--- Telegram Account MTProto Interactive Login ---');

  await client.start({
    phoneNumber: async () => process.env.TELEGRAM_PHONE || (await rl.question('Enter your Telegram phone number (+1234567890): ')),
    password: async () => await rl.question('Enter your 2FA Cloud Password (if enabled): '),
    phoneCode: async () => await rl.question('Enter the verification OTP received on Telegram: '),
    onError: (err) => console.error('Authentication Error:', err),
  });

  console.log('\nAuthentication successful!');
  const savedSession = client.session.save();
  console.log('\nYour persistent session string:');
  console.log(savedSession);
  console.log('\nSave this in your environment or RDS database securely.');

  rl.close();
  await client.disconnect();
}

authenticate().catch(console.error);
