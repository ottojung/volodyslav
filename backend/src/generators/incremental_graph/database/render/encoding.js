/**
 * Key encoding and value serialisation for the incremental-graph database
 * snapshot format.  Forwarded from the parent database/encoding module.
 *
 * Consumers outside the render/ folder should import from ../encoding
 * directly to avoid pulling in the render subsystem.
 */
module.exports = require('../encoding');
