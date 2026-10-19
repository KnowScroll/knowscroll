// Safe-area insets come from the library's own test double: no native module in Jest.
jest.mock(
  'react-native-safe-area-context',
  () => jest.requireActual('react-native-safe-area-context/jest/mock').default,
);
