jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));
// Pure helpers are what unit tests cover; the Supabase client itself is never exercised in jest.
jest.mock('./src/lib/supabase', () => ({
  supabase: {},
  SUPABASE_URL: 'http://test',
  configureSupabase: jest.fn(),
}));
