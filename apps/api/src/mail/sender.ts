/** The magic-link delivery port (ADR-0026 section 4); a leaf so both implementations can name it without importing each other. */

export interface MagicLinkSender {
  /** `to` is accepted because any real provider needs a destination; the development sink never
   * persists or logs it, and only `link` is ever written anywhere. */
  send(input: { to: string; link: string }): Promise<void>;
}
