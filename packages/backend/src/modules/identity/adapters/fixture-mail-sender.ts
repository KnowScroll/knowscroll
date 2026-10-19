import { appendFile } from 'node:fs/promises';
import type { MailSender, SignInMail } from '../application/ports.js';

/**
 * CI FIXTURE ONLY. Records each sign-in mail instead of sending it: in memory, and as one JSON
 * line per mail in `outboxFile` when given (so a test can read the link a separately started API
 * "sent"). Configuration refuses it outside `NODE_ENV=test` in a `ci` or `local` world, so a
 * deployed world can never start with it. The file holds live test tokens: tests put it in a
 * temporary folder they delete.
 */
export function fixtureMailSender(options: { readonly outboxFile: string | undefined }): MailSender & {
  readonly sent: readonly SignInMail[];
} {
  const sent: SignInMail[] = [];
  const send: MailSender = async (mail) => {
    sent.push(mail);
    if (options.outboxFile !== undefined)
      await appendFile(options.outboxFile, `${JSON.stringify({ fixture: true, to: mail.to, link: mail.link })}\n`, {
        mode: 0o600,
      });
    return { kind: 'sent' };
  };
  return Object.assign(send, { sent });
}
