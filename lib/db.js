const mongoose = require("mongoose");

// The caller passes config (config/index.js), so this module never reads the environment itself.
async function connect(config) {
  await mongoose.connect(config.mongoUri, { maxPoolSize: config.mongoMaxPoolSize });
  return mongoose;
}

module.exports = { connect };
