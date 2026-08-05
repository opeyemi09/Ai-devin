function ts() { return new Date().toISOString(); }
function log(...args) { console.log(ts(), ...args); }
function err(...args) { console.error(ts(), ...args); }
module.exports = { log, err };
