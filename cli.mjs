#!/usr/bin/env node
// Awaitlight CLI entry (`npx awaitlight` / global `awaitlight`).
// Starts the local server in-process so all environment variables
// (PORT, COCKPIT_REFRESH_MIN, COCKPIT_REFRESH_MODEL, …) pass through untouched.
import('./server.js');
