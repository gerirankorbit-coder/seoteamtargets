#!/usr/bin/env node
// Reset the STAGING test data: re-creates the test.* accounts and replaces their
// TEST entries/attendance. (The server also seeds them automatically on first start.)
//
//   npm run seed:staging        (starts the local staging DB if needed; reads .env.staging)
//
// Safety: the staging guard in server.js and lib/staging-seed.js both refuse any
// database whose name does not contain "staging".
'use strict';
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env.staging', quiet: true });
process.env.APP_ENV = process.env.APP_ENV || 'staging';

if (!process.env.MONGODB_URI) {
  console.error('✗ MONGODB_URI is not set (check .env.staging)');
  process.exit(1);
}

// Loading the app registers every model and applies the staging guard.
require('../server.js');
const mongoose = require('mongoose');
const { seedStagingData, TEST_USERS, TEST_PASSWORD } = require('../lib/staging-seed');

async function main() {
  if (mongoose.connection.readyState !== 1) await new Promise(r => mongoose.connection.once('open', r));
  console.log(`✓ Connected to staging database "${mongoose.connection.db.databaseName}"`);
  await new Promise(r => setTimeout(r, 1500)); // let the app's own startup seed finish first
  await seedStagingData(mongoose.models, { reset: true });
  console.log(`✓ Reset ${TEST_USERS.length} test users (password: ${process.env.STAGING_TEST_PASSWORD ? 'from STAGING_TEST_PASSWORD' : TEST_PASSWORD}) and 3 days of test data`);
  await mongoose.disconnect();
  process.exit(0); // the session store's sweep timer would otherwise keep the process alive
}

main().catch(err => { console.error('✗ Seed failed:', err.message); process.exit(1); });
