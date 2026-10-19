// Safe-area insets come from a fixed test double (the library's own mock): no native module in Jest.
jest.mock(
  'react-native-safe-area-context',
  () => jest.requireActual('react-native-safe-area-context/jest/mock').default,
);
