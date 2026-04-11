const logger = {
    info:  (...args) => console.log('[MSG] INFO:', ...args),
    warn:  (...args) => console.warn('[MSG] WARN:', ...args),
    error: (...args) => console.error('[MSG] ERROR:', ...args),
    debug: (...args) => {
        if (process.env.NODE_ENV !== 'production') {
            console.log('[MSG] DEBUG:', ...args);
        }
    }
};

module.exports = logger;
