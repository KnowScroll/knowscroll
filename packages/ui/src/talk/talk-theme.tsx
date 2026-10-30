import { createContext, useContext, type ReactNode } from 'react';
import { defaultTalkTheme, talkThemes, type TalkTheme, type TalkThemeName } from '@knowscroll/design-tokens';

const TalkThemeContext = createContext<TalkTheme>(talkThemes[defaultTalkTheme]);

/**
 * Names the Talk theme for everything below it: `sky` (dark, the default) or `paper`. Components
 * read roles from `useTalkTheme`, so a person's Paper setting (T-C) is a prop here and no
 * component changes.
 */
export function TalkThemeProvider({
  name = defaultTalkTheme,
  children,
}: {
  readonly name?: TalkThemeName;
  readonly children: ReactNode;
}) {
  return <TalkThemeContext.Provider value={talkThemes[name]}>{children}</TalkThemeContext.Provider>;
}

/** The roles of the Talk theme in force. */
export function useTalkTheme(): TalkTheme {
  return useContext(TalkThemeContext);
}
