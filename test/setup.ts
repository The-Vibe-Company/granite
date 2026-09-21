/**
 * Test bootstrap.
 *
 * Jev is required, so the MCP server and the CLI refuse to start without
 * `TYPESAFE_API_KEY`. The suite never calls TypeSafe — tests assert request shapes and
 * refusal behaviour with no network — but a placeholder key must exist for the constructors
 * to run at all. Tests that need to observe the missing-key path delete the variable
 * themselves and restore it.
 *
 * This is deliberately NOT a real credential and must never become one: a key in a public
 * repository is a key that has to be rotated.
 */
process.env.TYPESAFE_API_KEY ??= 'test-key-not-a-credential';
