import { useRef, useState } from 'react';
import { apiProblem, talkFailure, type AccountScope } from '@knowscroll/client-core';
import type { ContentThreadRef, SendThreadBody } from '@knowscroll/contracts';
import { newCommandId } from '../../platform/command-id';

export type SnippetSendStatus =
  | 'idle'
  | 'sending'
  /** "Shared" is shown only after the server's receipt. */
  | 'sent'
  /** No answer: the identical command is kept, so Retry cannot share twice. */
  | 'unconfirmed'
  | 'unavailable'
  | 'invalid'
  | 'failed';

/**
 * One send into a thread from a screen that is not the thread (the Scroll reader). The command's ID is
 * minted once per body and reused by every retry, so an unknown outcome can be retried without the
 * snippet arriving twice. The thread screen sends through its own controller instead.
 */
export function useSnippetSend(scope: AccountScope, thread: ContentThreadRef) {
  const [status, setStatus] = useState<SnippetSendStatus>('idle');
  const intent = useRef<{ readonly body: string; readonly commandId: string } | undefined>(undefined);
  const send = async (body: SendThreadBody): Promise<void> => {
    if (status === 'sending' || status === 'sent') return;
    const serialised = JSON.stringify(body);
    if (intent.current?.body !== serialised) intent.current = { body: serialised, commandId: newCommandId() };
    setStatus('sending');
    try {
      await scope.api.threads.send({ version: 'content-thread.v1', commandId: intent.current.commandId, thread, body });
      intent.current = undefined;
      setStatus('sent');
    } catch (error) {
      const kind = talkFailure(error);
      if (kind === 'ended') return;
      // The server says this thread does not hold the content or the anchor does not fit: a definite no, not a fault.
      if (apiProblem(error)?.code === 'INVALID_REQUEST') {
        intent.current = undefined;
        setStatus('invalid');
        return;
      }
      if (kind === 'unavailable') intent.current = undefined;
      setStatus(kind === 'unavailable' ? 'unavailable' : kind === 'offline' ? 'unconfirmed' : 'failed');
    }
  };
  return { status, send, reset: () => setStatus('idle') };
}
