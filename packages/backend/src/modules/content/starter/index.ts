import whyTheSkyIsBlue from './why-the-sky-is-blue.editorial-scroll.json' with { type: 'json' };

/**
 * The authored editorial Scrolls that ship with the backend (D-005). Each is an `editorial-scroll.v1`
 * source: publication facts, the authored `scroll-draft.v1` and its claims. They are admitted by
 * the operator command (`dist/operator.js content import-editorial --file <path>`), never at
 * startup, and are labelled `authored_editorial`: an authored piece is never presented as generated.
 * The JSON files are also emitted next to this module in `dist/`, so a release tree carries them.
 */
export const starterEditorialScrolls = [{ name: 'why-the-sky-is-blue', source: whyTheSkyIsBlue }] as const;
