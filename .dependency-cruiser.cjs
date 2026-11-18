// dependency-cruiser config used by `npm run arch`.
// The rules live in .dependency-cruiser.rules.cjs so the architecture test can reuse them.
const { makeConfig } = require("./.dependency-cruiser.rules.cjs");

module.exports = makeConfig("^packages/core/src");
