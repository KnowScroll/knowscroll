# Sharing & visibility (F02; #241, D-047)

The page where a person decides what friends may see, in Privacy & history (`/account/privacy/visibility`,
registered through `features/privacy/privacy-extensions.ts`, a card on desktops). Status marks: implemented
with component tests over a labelled in-memory server; not runtime-verified on dev.

| Control | What it does |
| --- | --- |
| Visitors: Nobody, Friends I choose, All friends | Who may visit the universe. Choosing friends lists the person's friends to tick. Nobody ticked is saved as nobody and the radio stays where the person put it |
| One switch for each system | Whether visitors see that system and the names of its planets. Regions are never shared |
| Activity status: Online, Recently active, Don't show | Whether friends see "Online" or "Recently active". It is its own command with its own revision, and never says what anyone is watching |

Everything starts off. Each change is one command (`createVisibilitySession`, client-core), shows Saving, Saved
or "Couldn't save" with Retry, and applies to every later visit at once. The page says that what a friend already
saw cannot be taken back. A page that changed on another device is replaced by what the server holds rather than
overwritten.

`choice-rows.tsx` holds the radio and switch rows (48 px, announced as radio and switch). Not built: "Preview
what Ravi sees".
