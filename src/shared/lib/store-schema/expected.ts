export interface ExpectedSchema {
  maxVersion: string;
  applied: number;
}

/** The schema level this build was made for. */
export function getExpectedSchema(): ExpectedSchema {
  if (typeof __STORE_EXPECTED_SCHEMA__ === 'undefined') {
    throw new Error('__STORE_EXPECTED_SCHEMA__ is not defined: build config did not inject it');
  }
  return __STORE_EXPECTED_SCHEMA__;
}
