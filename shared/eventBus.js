const EventEmitter = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(60);
module.exports = bus;
