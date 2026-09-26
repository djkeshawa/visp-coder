/**
 * Written for VISP. Compact worker replies show at most 800 characters of a skill's
 * body, so the steps stay under that bound and reach the worker whole.
 */
export const EDGE_CASES_FIRST_CONTENT = `---
name: edge-cases-first
description: Pin current behavior and the request's edge cases as tests before changing code, so a change or fix does not break nearby behavior.
appliesTo:
  stage:
    - implement
---
1. Before editing existing code, add tests that record what it returns now for nearby valid, invalid and error inputs, and run them. Keep them passing unless the request changes that behavior.
2. List the request's edge cases: empty or blank, boundaries, invalid or out of range, errors inside data, order and precedence. Add a test for the expected result of each.
3. Make the smallest change that passes, then run every test.
4. After every fix, including review fixes, run every test again.
5. Report which cases pass and which remain untested.
`;
